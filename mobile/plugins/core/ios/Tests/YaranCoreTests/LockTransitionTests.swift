/// LockTransitionTests: App Lock transitions that fail part-way (Sol native review round 5).
///
/// A guard change (passcode fallback toggled) runs through the production `SystemKeychainStore`
/// over a synthetic in-memory Security backend (`SecItemCalls`), so the guarded item's real
/// delete-then-add is what fails: the key must survive a failed rewrite, a failed setting save
/// and a restart in between. An invalidation whose cleanup cannot rewrite a namespace must not
/// report `invalidated` and must leave the lock on across a restart.
/// This proves Vault and AppLock logic and the store's call order; it is not the OS Keychain.
///
/// <module-headers:begin>
/// Uses:
/// YaranCoreTests/LockTransitionTests
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Foundation, Security, Testing
///
/// Used by: entry point (Swift Testing, via bash mobile/plugins/core/ios/test.sh)
/// <module-headers:end>

import Foundation
import Security
import Testing
@testable import YaranCore

/// Generic-password items by account, answering the SecItem calls the store makes.
private final class FakeSecItems: @unchecked Sendable {
    var items: [String: Data] = [:]
    var failAdds: Set<String> = []
    var failUpdates: Set<String> = []
    var failReads: Set<String> = []

    private func account(_ query: CFDictionary) -> String? { (query as NSDictionary)[kSecAttrAccount as String] as? String }

    var seam: SecItemCalls {
        SecItemCalls(add: { query in
            guard let account = self.account(query) else { return errSecParam }
            if self.failAdds.contains(account) { return errSecIO }
            if self.items[account] != nil { return errSecDuplicateItem }
            self.items[account] = (query as NSDictionary)[kSecValueData as String] as? Data
            return errSecSuccess
        }, update: { query, changes in
            guard let account = self.account(query) else { return errSecParam }
            if self.failUpdates.contains(account) { return errSecIO }
            guard self.items[account] != nil else { return errSecItemNotFound }
            self.items[account] = (changes as NSDictionary)[kSecValueData as String] as? Data
            return errSecSuccess
        }, delete: { query in
            guard let account = self.account(query) else { return errSecParam }
            return self.items.removeValue(forKey: account) == nil ? errSecItemNotFound : errSecSuccess
        }, copy: { query, result in
            if (query as NSDictionary)[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String {
                guard !self.items.isEmpty else { return errSecItemNotFound }
                result.pointee = self.items.keys.map { [kSecAttrAccount as String: $0] } as CFArray
                return errSecSuccess
            }
            if let account = self.account(query), self.failReads.contains(account) { return errSecInteractionNotAllowed }
            guard let account = self.account(query), let data = self.items[account] else { return errSecItemNotFound }
            result.pointee = data as CFData
            return errSecSuccess
        })
    }
}

struct LockTransitionTests {
    private static let main = Vault.guardedKeyAccount, staged = Vault.stagedKeyPrefix + "presence"

    private func open(_ items: FakeSecItems) -> (Vault, AppLock) {
        let vault = Vault(store: SystemKeychainStore(calls: items.seam), accessGroup: nil)
        return (vault, AppLock(vault: vault, biometry: { .available }))
    }

    private func lockedWithASession() throws -> FakeSecItems {
        let items = FakeSecItems()
        let (vault, lock) = open(items)
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        try vault.set(namespace: "session-direct", key: "h1", value: "tok", protection: .locked)
        return items
    }

    @Test func aGuardChangeWhoseMainRewriteFailsKeepsTheKey() throws {
        let items = try lockedWithASession()
        let (_, lock) = open(items)
        #expect(try lock.unlock() == .unlocked)
        items.failAdds = [Self.main] // the delete of the old item succeeds, the add of the new one fails
        try lock.setOptions(grace: nil, allowPasscode: true)
        #expect(items.items[Self.main] == nil && items.items[Self.staged] != nil, "the hazard ran: only the staged copy holds the key")
        items.failAdds = []
        let (vault, restarted) = open(items)
        #expect(restarted.status().allowPasscode && restarted.status().locked)
        #expect(try restarted.unlock() == .unlocked)
        #expect(try vault.get(namespace: "session-direct", key: "h1") == "tok")
        #expect(items.items[Self.main] != nil && items.items[Self.staged] == nil, "the main copy was repaired from the staged one")
    }

    /// The state finding 1 starts from: a guard change whose main rewrite failed, so the staged
    /// copy is the only one holding the key.
    private func stagedOnly() throws -> FakeSecItems {
        let items = try lockedWithASession()
        let (_, lock) = open(items)
        #expect(try lock.unlock() == .unlocked)
        items.failAdds = [Self.main]
        try lock.setOptions(grace: nil, allowPasscode: true)
        items.failAdds = []
        #expect(items.items[Self.main] == nil && items.items[Self.staged] != nil)
        return items
    }

    // Round 6: the settings cannot be read at the next start. Unreadable is not "lock off":
    // the staged copy is kept, the lock stays engaged, an unlock fails rather than opening,
    // and once the read works again the same instance unlocks with the session intact.
    @Test func unreadableSettingsKeepTheLockAndTheStagedKey() throws {
        let items = try stagedOnly()
        items.failReads = ["meta.applock"]
        let (vault, restarted) = open(items)
        #expect(restarted.status().locked && restarted.status().enabled)
        #expect(items.items[Self.staged] != nil, "nothing was recovered or dropped on a guess")
        #expect(throws: VaultError.locked) { try vault.get(namespace: "session-direct", key: "h1") }
        #expect(throws: VaultError.unavailable) { try restarted.unlock() }
        #expect(restarted.status().locked)
        #expect(throws: VaultError.unavailable) { try restarted.setOptions(grace: .immediately, allowPasscode: nil) }
        items.failReads = []
        #expect(try restarted.unlock() == .unlocked)
        #expect(try vault.get(namespace: "session-direct", key: "h1") == "tok")
        #expect(items.items[Self.main] != nil && items.items[Self.staged] == nil)
    }

    // Undecodable settings are the same: locked, the staged copy kept, no unlock on an error.
    @Test func undecodableSettingsKeepTheLockAndTheStagedKey() throws {
        let items = try stagedOnly()
        items.items["meta.applock"] = Data("not json".utf8)
        let (vault, restarted) = open(items)
        #expect(restarted.status().locked)
        #expect(items.items[Self.staged] != nil)
        #expect(throws: VaultError.unavailable) { try restarted.unlock() }
        #expect(throws: VaultError.locked) { try vault.get(namespace: "session-direct", key: "h1") }
    }

    // Truly absent settings are a first install: the defaults, unlocked.
    @Test func missingSettingsAreAFirstInstall() throws {
        let (_, lock) = open(FakeSecItems())
        #expect(!lock.status().enabled && !lock.status().locked)
        #expect(try lock.unlock() == .unlocked)
    }

    @Test func aGuardChangeWhoseSettingCannotBeSavedRollsBack() throws {
        let items = try lockedWithASession()
        let (_, lock) = open(items)
        #expect(try lock.unlock() == .unlocked)
        items.failUpdates = ["meta.applock"]
        #expect(throws: (any Error).self) { try lock.setOptions(grace: nil, allowPasscode: true) }
        #expect(!lock.status().allowPasscode && items.items[Self.staged] == nil)
        items.failUpdates = []
        let (vault, restarted) = open(items)
        #expect(!restarted.status().allowPasscode)
        #expect(try restarted.unlock() == .unlocked)
        #expect(try vault.get(namespace: "session-direct", key: "h1") == "tok")
    }

    @Test func aGuardChangeInterruptedBeforeItsSettingIsDroppedAtStart() throws {
        let items = try lockedWithASession()
        let (vault, lock) = open(items)
        #expect(try lock.unlock() == .unlocked)
        try vault.stageReguard(.userPresence) // the process dies here, before the setting is saved
        let (again, restarted) = open(items)
        #expect(items.items[Self.staged] == nil && !restarted.status().allowPasscode)
        #expect(try restarted.unlock() == .unlocked)
        #expect(try again.get(namespace: "session-direct", key: "h1") == "tok")
    }

    @Test func aFailedInvalidationCleanupKeepsTheLockAcrossARestart() throws {
        let store = InMemoryKeychainStore()
        let vault = Vault(store: store, accessGroup: nil)
        let lock = AppLock(vault: vault, biometry: { .available })
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        try vault.set(namespace: "session-direct", key: "h1", value: "legacy", protection: .standard)
        try vault.set(namespace: "session-direct", key: "names", value: "a.example.com", protection: .standard)
        store.drop(service: Vault.service, account: Vault.guardedKeyAccount)
        store.failingWrites = ["ns.session-direct"]
        let first = Vault(store: store, accessGroup: nil)
        #expect(throws: (any Error).self) { try AppLock(vault: first, biometry: { .available }).unlock() }
        let restarted = Vault(store: store, accessGroup: nil)
        let relock = AppLock(vault: restarted, biometry: { .available })
        #expect(relock.status().enabled && relock.status().locked)
        #expect(throws: VaultError.locked) { try restarted.get(namespace: "session-direct", key: "h1") }
        #expect(try restarted.get(namespace: "session-direct", key: "names") == "a.example.com")
        store.failingWrites = []
        #expect(try relock.unlock() == .invalidated)
        #expect(try restarted.list(namespace: "session-direct") == ["names"])
    }
}
