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
/// - The lock seam (`unlock`, `guardDataKey`, `unguardDataKey`, `wipeLocked`, in
///   `Vault+LockSeam.swift`) is driven by `AppLock`; plugins call only the namespace methods.
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
/// ├── YaranCore/Vault+LockSeam (inferred)
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

    // Internal, not private: the lock seam in `Vault+LockSeam.swift` uses these.
    let store: KeychainStore
    private let accessGroup: String?
    private let sharedPrefixes: [String]
    private let mutex = NSRecursiveLock()
    var dataKey: SymmetricKey?
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

    /// The native session namespaces (machine-view's org `session/<host>` and direct
    /// `session-direct/<host>` records): bearer secrets, always written in the locked class and
    /// promoted there when the lock is enabled. Their `names` index lists host names, not
    /// secrets, and stays standard so it can be listed while locked.
    public static let sessionNamespaces = ["session", "session-direct"]
    public static let sessionIndexKey = "names"

    static func isSessionSecret(_ namespace: String, _ key: String) -> Bool {
        sessionNamespaces.contains(namespace) && key != sessionIndexKey
    }

    func promoteToLocked(_ namespace: String) throws {
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

    struct Blob: Codable {
        // `v` is the stored blob's version field; renaming it would change what is on disk.
        // swiftlint:disable:next identifier_name
        var v = 1
        var standard: [String: String] = [:]
        var locked: Data?
    }

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        mutex.lock(); defer { mutex.unlock() }
        return try body()
    }

    /// Plain namespace I/O never prompts, so every Keychain failure there is `unavailable`.
    func io<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch is KeychainFailure { throw VaultError.unavailable }
    }

    private func validate(_ namespace: String, _ key: String) throws {
        guard Self.isValidNamespace(namespace), Self.isValidKey(key) else { throw VaultError.invalidArgument }
    }

    func item(account: String, shared: Bool) -> KeychainItem {
        shared
            ? KeychainItem(service: Self.service, account: account, access: .afterFirstUnlockThisDeviceOnly,
                           accessGroup: accessGroup)
            : KeychainItem(service: Self.service, account: account, access: .whenUnlockedThisDeviceOnly)
    }

    private func namespaceItem(_ namespace: String) -> KeychainItem {
        item(account: "ns." + namespace, shared: sharedPrefixes.contains { namespace.hasPrefix($0) })
    }

    func guardedKeyItem(_ guardKind: KeychainGuard) -> KeychainItem {
        KeychainItem(service: Self.service, account: Self.guardedKeyAccount,
                     access: .whenPasscodeSetThisDeviceOnly, guardedBy: guardKind)
    }

    func stagedKeyItem(_ guardKind: KeychainGuard) -> KeychainItem {
        let suffix = guardKind == .userPresence ? "presence" : "biometry"
        return KeychainItem(service: Self.service, account: Self.stagedKeyPrefix + suffix,
                            access: .whenPasscodeSetThisDeviceOnly, guardedBy: guardKind)
    }

    func readBlob(_ namespace: String) throws -> Blob {
        guard let data = try io({ try store.read(namespaceItem(namespace), prompt: nil) }) else { return Blob() }
        guard let blob = try? JSONDecoder().decode(Blob.self, from: data), blob.v == 1 else {
            throw VaultError.tampered
        }
        return blob
    }

    func writeBlob(_ blob: Blob, _ namespace: String) throws {
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
    func lockedKey(create: Bool) throws -> SymmetricKey? {
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

    static func key(from data: Data) throws -> SymmetricKey {
        guard data.count == 32 else { throw VaultError.tampered }
        return SymmetricKey(data: data)
    }
}
