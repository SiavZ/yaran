/// Vault: the device-bound, namespaced secret store of the phone app (iOS).
///
/// One Keychain generic-password item per namespace holds a small JSON blob: a `standard` map
/// of plain values and, when present, a `locked` map sealed with AES-GCM under a 256-bit data
/// key. That data key lives in its own Keychain item: unguarded while the app lock is off, and
/// guarded by `SecAccessControl` (biometry, or user presence with passcode fallback) while it
/// is on, so only a successful Face ID / Touch ID read can open the `locked` class.
///
/// - Standard items use `WhenUnlockedThisDeviceOnly`; namespaces the push NSE shares
///   (`sharedPrefixes`) use `AfterFirstUnlockThisDeviceOnly` in the app-group access group.
/// - A blob that does not decode or authenticate is `VaultError.tampered`, never empty.
/// - The lock seam (`unlock`, `guardDataKey`, `unguardDataKey`, `wipeLocked`) is driven by
///   `AppLock`; plugins call only the namespace methods.
/// - Thread-safe: every call runs under one recursive lock.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/Vault
/// └── YaranCore/KeychainStore (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// YaranCore/Vault
/// ├── AppTests/KeychainAccessTests (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/PluginArguments (inferred)
/// ├── YaranCoreTests/LockTransitionTests (inferred)
/// ├── YaranCoreTests/PluginArgumentsTests (inferred)
/// ├── YaranCoreTests/VaultTests (inferred)
/// └── YaranSecureStorePlugin/SecureStorePlugin (inferred)
/// <module-headers:end>

import CryptoKit
import Foundation

/// The stable error set (raw values cross the bridge). "Not found" is not an error.
public enum VaultError: String, Error, Equatable, Sendable {
    case tampered, invalidated, locked, unavailable
    case invalidArgument = "invalid_argument"
}

/// `standard`: device-bound, no user auth. `locked`: sealed under the app-lock data key.
public enum Protection: String, Sendable, CaseIterable {
    case standard, locked
}

public final class Vault: @unchecked Sendable {
    public static let service = "io.github.siavz.yaran.vault"
    static let dataKeyAccount = "key.locked"
    static let guardedKeyAccount = "key.locked.guarded"
    /// A guard change in progress: the data key behind the NEW guard, one account per guard kind.
    static let stagedKeyPrefix = "key.locked.guarded.next."

    /// The app-wide instance, built on the real Keychain with the `group.<bundle id>` group.
    public static let shared = Vault(
        store: SystemKeychainStore(),
        accessGroup: Bundle.main.bundleIdentifier.map { "group." + $0 }
    )

    private let store: KeychainStore
    private let accessGroup: String?
    private let sharedPrefixes: [String]
    private let mutex = NSRecursiveLock()
    private var dataKey: SymmetricKey?
    /// Mirrors `AppLock`'s persisted setting; true means the data key sits behind the guard.
    var lockEnabled = false

    public init(store: KeychainStore, accessGroup: String?, sharedPrefixes: [String] = ["push"]) {
        self.store = store
        self.accessGroup = accessGroup
        self.sharedPrefixes = sharedPrefixes
    }

    public static func isValidNamespace(_ name: String) -> Bool {
        name.range(of: #"^[a-z0-9-]{1,32}$"#, options: .regularExpression) != nil
    }

    public static func isValidKey(_ name: String) -> Bool {
        name.range(of: #"^[A-Za-z0-9._-]{1,64}$"#, options: .regularExpression) != nil
    }

    // MARK: Namespace API

    public func get(namespace: String, key: String) throws -> String? {
        try withLock {
            try validate(namespace, key)
            let blob = try readBlob(namespace)
            if let value = blob.standard[key] {
                // A session secret an older build left standard is as locked as the class it belongs in.
                if Self.isSessionSecret(namespace, key), lockEnabled, dataKey == nil { throw VaultError.locked }
                return value
            }
            return try openLocked(blob, namespace)[key]
        }
    }

    public func set(namespace: String, key: String, value: String, protection: Protection) throws {
        try withLock {
            try validate(namespace, key)
            var blob = try readBlob(namespace)
            var locked = try openLocked(blob, namespace)
            switch protection {
            case .standard:
                blob.standard[key] = value
                locked[key] = nil
            case .locked:
                blob.standard[key] = nil
                locked[key] = value
            }
            blob.locked = try sealLocked(locked, namespace)
            try writeBlob(blob, namespace)
        }
    }

    public func remove(namespace: String, key: String) throws {
        try withLock {
            try validate(namespace, key)
            var blob = try readBlob(namespace)
            var locked = try openLocked(blob, namespace)
            guard blob.standard[key] != nil || locked[key] != nil else { return }
            blob.standard[key] = nil
            locked[key] = nil
            blob.locked = try sealLocked(locked, namespace)
            try writeBlob(blob, namespace)
        }
    }

    public func list(namespace: String) throws -> [String] {
        try withLock {
            try validate(namespace, "k")
            let blob = try readBlob(namespace)
            return (Array(blob.standard.keys) + Array(try openLocked(blob, namespace).keys)).sorted()
        }
    }

    /// "Erase everything on this phone": every namespace, the metadata and both key items.
    public func eraseAll() throws {
        try withLock {
            for account in try io({ try store.accounts(service: Self.service) }) {
                try io { try store.delete(item(account: account, shared: false)) }
            }
            dataKey = nil
            lockEnabled = false
        }
    }

    // MARK: Metadata (native settings that must not be reachable from JS namespaces)

    func readMeta(_ name: String) throws -> Data? {
        try withLock { try io { try store.read(item(account: "meta." + name, shared: false), prompt: nil) } }
    }

    func writeMeta(_ name: String, _ data: Data) throws {
        try withLock { try io { try store.write(data, to: item(account: "meta." + name, shared: false)) } }
    }

    // MARK: Lock seam (AppLock only). Keychain failures pass through as KeychainFailure.

    var isUnlocked: Bool { withLock { dataKey != nil } }

    /// Reads the guarded key (this is the biometric prompt). Missing item = `invalidated`.
    /// A copy staged by an unfinished guard change (`stageReguard`) is read first, since it carries
    /// the guard the saved setting asks for, and the main copy is then rewritten from it.
    func unlock(guardedBy guardKind: KeychainGuard, prompt: String) throws {
        try withLock {
            let staged = try store.read(stagedKeyItem(guardKind), prompt: prompt)
            guard let data = try staged ?? store.read(guardedKeyItem(guardKind), prompt: prompt) else {
                throw VaultError.invalidated
            }
            dataKey = try Self.key(from: data)
            if staged != nil, (try? store.write(data, to: guardedKeyItem(guardKind))) != nil {
                try? store.delete(stagedKeyItem(guardKind))
            }
            // A lock an older build enabled never promoted its standard session entries: do it at the
            // first unlock. A failure keeps them standard, still refused while locked by `get`.
            for namespace in Self.sessionNamespaces { try? promoteToLocked(namespace) }
        }
    }

    /// Forgets the in-memory data key so the `locked` class needs a fresh unlock.
    func engage() {
        withLock { if lockEnabled { dataKey = nil } }
    }

    // A lock transition is three steps: write the new key copy, save AppLock's setting, drop the
    // old copy. Until the setting is durable both copies exist, so a failed save rolls back and a
    // process that died anywhere is repaired at the next start (`recoverGuard`) with no key lost.

    /// Writes the data key behind the guard and proves one unlock; the plain copy stays until
    /// `finishGuard`. Any legacy standard-class session secret moves into the locked class first,
    /// one atomic write per namespace; a failure throws before anything else changes.
    func guardDataKey(_ guardKind: KeychainGuard, prompt: String) throws {
        try withLock {
            for namespace in Self.sessionNamespaces { try promoteToLocked(namespace) }
            let key = try lockedKey(create: true) ?? SymmetricKey(size: .bits256)
            try store.write(key.withUnsafeBytes { Data($0) }, to: guardedKeyItem(guardKind))
            do {
                try unlock(guardedBy: guardKind, prompt: prompt)
            } catch {
                try? store.delete(guardedKeyItem(guardKind))
                throw error
            }
        }
    }

    /// The enabled setting is saved: drop the plain copy. A failed delete is retried by `recoverGuard`.
    func finishGuard() {
        withLock {
            lockEnabled = true
            try? store.delete(item(account: Self.dataKeyAccount, shared: false))
        }
    }

    /// The setting could not be saved: the guarded copy goes, the plain one never left.
    func abandonGuard(_ guardKind: KeychainGuard) {
        withLock { try? store.delete(guardedKeyItem(guardKind)) }
    }

    /// Prompts, then writes the data key back to a plain item; the guarded copy stays until `finishUnguard`.
    func unguardDataKey(_ guardKind: KeychainGuard, prompt: String) throws {
        try withLock {
            try unlock(guardedBy: guardKind, prompt: prompt)
            guard let key = dataKey else { throw VaultError.locked }
            try store.write(key.withUnsafeBytes { Data($0) }, to: item(account: Self.dataKeyAccount, shared: false))
        }
    }

    /// The disabled setting is saved: drop the guarded copy.
    func finishUnguard(_ guardKind: KeychainGuard) {
        withLock {
            lockEnabled = false
            try? store.delete(guardedKeyItem(guardKind))
        }
    }

    /// The setting could not be saved: the plain copy goes, the lock stays as it was.
    func abandonUnguard() {
        withLock { try? store.delete(item(account: Self.dataKeyAccount, shared: false)) }
    }

    /// At start, with AppLock's saved setting as the truth: an interrupted transition left both
    /// copies, and the one the setting no longer needs is dropped. Lock on: the plain copy goes
    /// (only if the guarded one is really there). Lock off: the guarded copy goes. A guard change
    /// whose setting was never saved leaves a staged copy for the other guard kind: it goes.
    func recoverGuard(enabled: Bool, _ guardKind: KeychainGuard) {
        withLock {
            let accounts = (try? store.accounts(service: Self.service)) ?? []
            for kind in [KeychainGuard.biometryCurrentSet, .userPresence] where !enabled || kind != guardKind {
                if accounts.contains(stagedKeyItem(kind).account) { try? store.delete(stagedKeyItem(kind)) }
            }
            let plain = accounts.contains(Self.dataKeyAccount), guarded = accounts.contains(Self.guardedKeyAccount)
            guard plain && guarded else { return }
            if enabled {
                try? store.delete(item(account: Self.dataKeyAccount, shared: false))
            } else {
                try? store.delete(guardedKeyItem(guardKind))
            }
        }
    }

    // A guard change (passcode fallback toggled) is the same three steps, with no plain copy: the
    // key is staged behind the new guard, AppLock saves its setting, then the main copy takes the
    // new guard. Until that lands, `unlock` reads the staged copy, and repairs the main one.

    /// Writes the data key behind `guardKind` in a staged item. Needs an unlock.
    func stageReguard(_ guardKind: KeychainGuard) throws {
        try withLock {
            guard let key = dataKey else { throw VaultError.locked }
            try store.write(key.withUnsafeBytes { Data($0) }, to: stagedKeyItem(guardKind))
        }
    }

    /// The setting is saved: the main copy takes the new guard and the staged one goes. A failed
    /// rewrite keeps the staged copy, which the next unlock reads and repairs from.
    func finishReguard(_ guardKind: KeychainGuard) {
        withLock {
            guard let key = dataKey, (try? store.write(key.withUnsafeBytes { Data($0) }, to: guardedKeyItem(guardKind))) != nil else { return }
            try? store.delete(stagedKeyItem(guardKind))
        }
    }

    /// The setting could not be saved: the staged copy goes; the main copy never changed.
    func abandonReguard(_ guardKind: KeychainGuard) {
        withLock { try? store.delete(stagedKeyItem(guardKind)) }
    }

    /// Drops every `locked` map and both key items; with the lock on, a fresh guarded key
    /// replaces the lost one so the lock keeps working. `standard` values survive.
    func wipeLocked(guardedBy guardKind: KeychainGuard) throws {
        try withLock {
            for account in try io({ try store.accounts(service: Self.service) }) where account.hasPrefix("ns.") {
                let namespace = String(account.dropFirst(3))
                var blob = try readBlob(namespace)
                // A session secret an older build left standard goes too: its lock is what was just lost.
                let legacy = blob.standard.keys.filter { Self.isSessionSecret(namespace, $0) }
                guard blob.locked != nil || !legacy.isEmpty else { continue }
                blob.locked = nil
                legacy.forEach { blob.standard[$0] = nil }
                try writeBlob(blob, namespace)
            }
            try io { try store.delete(item(account: Self.dataKeyAccount, shared: false)) }
            for kind in [KeychainGuard.biometryCurrentSet, .userPresence] { try io { try store.delete(stagedKeyItem(kind)) } }
            try io { try store.delete(guardedKeyItem(guardKind)) }
            dataKey = nil
            if lockEnabled {
                let fresh = SymmetricKey(size: .bits256)
                try io { try store.write(fresh.withUnsafeBytes { Data($0) }, to: guardedKeyItem(guardKind)) }
                dataKey = fresh
            }
        }
    }

    /// The native session namespaces (machine-view's org `session/<host>` and direct
    /// `session-direct/<host>` records): bearer secrets, always written in the locked class and
    /// promoted there when the lock is enabled. Their `names` index lists host names, not
    /// secrets, and stays standard so it can be listed while locked.
    public static let sessionNamespaces = ["session", "session-direct"]
    public static let sessionIndexKey = "names"

    static func isSessionSecret(_ namespace: String, _ key: String) -> Bool {
        sessionNamespaces.contains(namespace) && key != sessionIndexKey
    }

    private func promoteToLocked(_ namespace: String) throws {
        var blob = try readBlob(namespace)
        let legacy = blob.standard.filter { Self.isSessionSecret(namespace, $0.key) }
        guard !legacy.isEmpty else { return }
        var locked = try openLocked(blob, namespace)
        for (key, value) in legacy {
            locked[key] = value
            blob.standard[key] = nil
        }
        blob.locked = try sealLocked(locked, namespace)
        try writeBlob(blob, namespace)
    }

    // MARK: Internals

    private struct Blob: Codable {
        // `v` is the stored blob's version field; renaming it would change what is on disk.
        // swiftlint:disable:next identifier_name
        var v = 1
        var standard: [String: String] = [:]
        var locked: Data?
    }

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        mutex.lock(); defer { mutex.unlock() }
        return try body()
    }

    /// Plain namespace I/O never prompts, so every Keychain failure there is `unavailable`.
    private func io<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch is KeychainFailure { throw VaultError.unavailable }
    }

    private func validate(_ namespace: String, _ key: String) throws {
        guard Self.isValidNamespace(namespace), Self.isValidKey(key) else { throw VaultError.invalidArgument }
    }

    private func item(account: String, shared: Bool) -> KeychainItem {
        shared
            ? KeychainItem(service: Self.service, account: account, access: .afterFirstUnlockThisDeviceOnly,
                           accessGroup: accessGroup)
            : KeychainItem(service: Self.service, account: account, access: .whenUnlockedThisDeviceOnly)
    }

    private func namespaceItem(_ namespace: String) -> KeychainItem {
        item(account: "ns." + namespace, shared: sharedPrefixes.contains { namespace.hasPrefix($0) })
    }

    private func guardedKeyItem(_ guardKind: KeychainGuard) -> KeychainItem {
        KeychainItem(service: Self.service, account: Self.guardedKeyAccount,
                     access: .whenPasscodeSetThisDeviceOnly, guardedBy: guardKind)
    }

    private func stagedKeyItem(_ guardKind: KeychainGuard) -> KeychainItem {
        let suffix = guardKind == .userPresence ? "presence" : "biometry"
        return KeychainItem(service: Self.service, account: Self.stagedKeyPrefix + suffix,
                            access: .whenPasscodeSetThisDeviceOnly, guardedBy: guardKind)
    }

    private func readBlob(_ namespace: String) throws -> Blob {
        guard let data = try io({ try store.read(namespaceItem(namespace), prompt: nil) }) else { return Blob() }
        guard let blob = try? JSONDecoder().decode(Blob.self, from: data), blob.v == 1 else {
            throw VaultError.tampered
        }
        return blob
    }

    private func writeBlob(_ blob: Blob, _ namespace: String) throws {
        if blob.standard.isEmpty && blob.locked == nil {
            try io { try store.delete(namespaceItem(namespace)) }
            return
        }
        let data = try JSONEncoder().encode(blob)
        try io { try store.write(data, to: namespaceItem(namespace)) }
    }

    private func openLocked(_ blob: Blob, _ namespace: String) throws -> [String: String] {
        guard let sealed = blob.locked else { return [:] }
        guard let key = try lockedKey(create: false) else { throw VaultError.tampered }
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            let plain = try AES.GCM.open(box, using: key, authenticating: Data(namespace.utf8))
            return try JSONDecoder().decode([String: String].self, from: plain)
        } catch {
            throw VaultError.tampered
        }
    }

    private func sealLocked(_ map: [String: String], _ namespace: String) throws -> Data? {
        guard !map.isEmpty else { return nil }
        guard let key = try lockedKey(create: true) else { throw VaultError.locked }
        let plain = try JSONEncoder().encode(map)
        guard let combined = try AES.GCM.seal(plain, using: key, authenticating: Data(namespace.utf8)).combined else {
            throw VaultError.unavailable
        }
        return combined
    }

    /// The `locked`-class key: the cached one, else (lock off) the plain item, created on demand.
    private func lockedKey(create: Bool) throws -> SymmetricKey? {
        if let dataKey { return dataKey }
        if lockEnabled { throw VaultError.locked }
        let plainItem = item(account: Self.dataKeyAccount, shared: false)
        if let data = try io({ try store.read(plainItem, prompt: nil) }) {
            dataKey = try Self.key(from: data)
            return dataKey
        }
        guard create else { return nil }
        let key = SymmetricKey(size: .bits256)
        try io { try store.write(key.withUnsafeBytes { Data($0) }, to: plainItem) }
        dataKey = key
        return key
    }

    private static func key(from data: Data) throws -> SymmetricKey {
        guard data.count == 32 else { throw VaultError.tampered }
        return SymmetricKey(data: data)
    }
}
