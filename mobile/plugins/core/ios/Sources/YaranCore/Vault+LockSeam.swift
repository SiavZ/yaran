/// Vault's lock seam: the data-key transitions `AppLock` drives (unlock, guard, unguard,
/// reguard, recovery and the locked-class wipe).
///
/// Split from `Vault.swift` by concern; plugins never call these, only `AppLock` does.
///
/// - Keychain failures pass through as `KeychainFailure`; every call runs under the vault's lock.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/Vault+LockSeam
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: CryptoKit, Foundation
///
/// Used by: entry point (a Swift extension of Vault, compiled into the YaranCore module (no import names it); AppLock calls it)
/// <module-headers:end>

import CryptoKit
import Foundation

extension Vault {
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
}
