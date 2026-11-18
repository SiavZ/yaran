/// VaultTests: Vault and AppLock behaviour against the in-memory Keychain store.
///
/// Covers the round trip in both protection classes, namespace isolation, tamper detection
/// (a bad blob is an explicit error, never empty), the access classes chosen per namespace,
/// the lock gate and the invalidation path, plus the `shouldLock` grace table.
///
/// - The hosted AppTests repeat the access-class checks against the real Keychain.
///
/// <module-headers:begin>
/// Uses:
/// YaranCoreTests/VaultTests
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/KeychainStore (inferred)
/// ├── YaranCore/Vault (inferred)
/// └── YaranCoreTests/FixtureTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash mobile/plugins/core/ios/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import YaranCore

private func makeVault() -> (Vault, InMemoryKeychainStore) {
    let store = InMemoryKeychainStore()
    return (Vault(store: store, accessGroup: "group.com.example.yaran"), store)
}

struct VaultTests {
    @Test func roundTripsBothProtectionClasses() throws {
        let (vault, _) = makeVault()
        try vault.set(namespace: "orgs", key: "list", value: "[1]", protection: .standard)
        try vault.set(namespace: "orgs", key: "secret", value: "s", protection: .locked)
        #expect(try vault.get(namespace: "orgs", key: "list") == "[1]")
        #expect(try vault.get(namespace: "orgs", key: "secret") == "s")
        #expect(try vault.get(namespace: "orgs", key: "missing") == nil)
        #expect(try vault.list(namespace: "orgs") == ["list", "secret"])
        try vault.set(namespace: "orgs", key: "secret", value: "plain", protection: .standard)
        #expect(try vault.list(namespace: "orgs") == ["list", "secret"])
        try vault.remove(namespace: "orgs", key: "secret")
        try vault.remove(namespace: "orgs", key: "list")
        #expect(try vault.list(namespace: "orgs").isEmpty)
    }

    @Test func namespacesAreIsolated() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "a", key: "k", value: "1", protection: .locked)
        try vault.set(namespace: "b", key: "k", value: "2", protection: .standard)
        #expect(try vault.get(namespace: "a", key: "k") == "1")
        #expect(try vault.get(namespace: "b", key: "k") == "2")
        try vault.remove(namespace: "a", key: "k")
        #expect(try vault.get(namespace: "b", key: "k") == "2")
        #expect(store.stored(service: Vault.service, account: "ns.a") == nil)
    }

    @Test func swappedSealedBlobIsTampered() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "a", key: "k", value: "1", protection: .locked)
        try vault.set(namespace: "b", key: "k", value: "2", protection: .locked)
        let itemA = try #require(store.stored(service: Vault.service, account: "ns.a"))
        let blobA = try #require(try store.read(itemA, prompt: nil))
        store.corrupt(service: Vault.service, account: "ns.b", with: blobA)
        #expect(throws: VaultError.tampered) { try vault.get(namespace: "b", key: "k") }
    }

    @Test func undecodableBlobIsTampered() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "a", key: "k", value: "1", protection: .standard)
        store.corrupt(service: Vault.service, account: "ns.a", with: Data("not json".utf8))
        #expect(throws: VaultError.tampered) { try vault.get(namespace: "a", key: "k") }
        #expect(throws: VaultError.tampered) { try vault.set(namespace: "a", key: "x", value: "y", protection: .standard) }
    }

    @Test func badArgumentsAreRefused() {
        let (vault, _) = makeVault()
        #expect(throws: VaultError.invalidArgument) { try vault.get(namespace: "Bad", key: "k") }
        #expect(throws: VaultError.invalidArgument) { try vault.get(namespace: "ok", key: "a/b") }
    }

    @Test func accessClassFollowsNamespace() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "orgs", key: "k", value: "v", protection: .standard)
        try vault.set(namespace: "push-keys", key: "k", value: "v", protection: .standard)
        let own = try #require(store.stored(service: Vault.service, account: "ns.orgs"))
        #expect(own.access == .whenUnlockedThisDeviceOnly && own.accessGroup == nil)
        let shared = try #require(store.stored(service: Vault.service, account: "ns.push-keys"))
        #expect(shared.access == .afterFirstUnlockThisDeviceOnly && shared.accessGroup == "group.com.example.yaran")
    }

    @Test func eraseAllRemovesEverything() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "a", key: "k", value: "1", protection: .locked)
        try vault.eraseAll()
        #expect(try store.accounts(service: Vault.service).isEmpty)
        #expect(try vault.get(namespace: "a", key: "k") == nil)
    }
}

struct AppLockTests {
    @Test func lockGuardsTheLockedClassOnly() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "s", key: "token", value: "t", protection: .locked)
        try vault.set(namespace: "s", key: "name", value: "n", protection: .standard)
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        let guarded = try #require(store.stored(service: Vault.service, account: Vault.guardedKeyAccount))
        #expect(guarded.guardedBy == .biometryCurrentSet && guarded.access == .whenPasscodeSetThisDeviceOnly)
        #expect(store.stored(service: Vault.service, account: Vault.dataKeyAccount) == nil)

        lock.engage()
        #expect(lock.locked)
        #expect(throws: VaultError.locked) { try vault.get(namespace: "s", key: "token") }
        #expect(try vault.get(namespace: "s", key: "name") == "n")

        store.guardedReadFailure = .cancelled
        #expect(try lock.unlock() == .cancelled)
        #expect(lock.locked)
        store.guardedReadFailure = nil
        #expect(try lock.unlock() == .unlocked)
        #expect(try vault.get(namespace: "s", key: "token") == "t")

        // A fresh process reads the persisted setting and starts locked.
        let relaunched = AppLock(vault: Vault(store: store, accessGroup: nil), biometry: { .available })
        #expect(relaunched.status().enabled && relaunched.locked)
    }

    // A session token an older build wrote while the lock was off must not stay readable once it is on.
    @Test func enablingTheLockMovesLegacySessionEntriesIntoTheLockedClass() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .standard)
        try vault.set(namespace: "session-direct", key: "names", value: "a.example.com", protection: .standard)
        try vault.set(namespace: "session", key: "h2", value: "access-jwt", protection: .standard)
        try vault.set(namespace: "orgs", key: "list", value: "[]", protection: .standard)
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        lock.engage()
        #expect(throws: VaultError.locked) { try vault.get(namespace: "session-direct", key: "h1") }
        #expect(throws: VaultError.locked) { try vault.get(namespace: "session", key: "h2") }
        #expect(try vault.get(namespace: "session-direct", key: "names") == "a.example.com")
        #expect(try vault.get(namespace: "orgs", key: "list") == "[]")
        let item = KeychainItem(service: Vault.service, account: "ns.session-direct", access: .whenUnlockedThisDeviceOnly)
        let raw = try #require(try store.read(item, prompt: nil))
        #expect(!String(decoding: raw, as: UTF8.self).contains("direct-token"))
    }

    @Test func aFailedPromotionLeavesTheLockOffAndEveryEntryReadable() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .standard)
        let bad = KeychainItem(service: Vault.service, account: "ns.session", access: .whenUnlockedThisDeviceOnly)
        try store.write(Data("not a blob".utf8), to: bad)
        #expect(throws: VaultError.tampered) { try lock.enable(allowPasscode: false) }
        #expect(!lock.status().enabled)
        #expect(try vault.get(namespace: "session-direct", key: "h1") == "direct-token")
    }

    // F8: the enable's setting cannot be saved. Nothing is lost and the lock stays off.
    @Test func anEnableWhoseSettingCannotBeSavedRollsBack() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .locked)
        store.failingWrites = ["meta.applock"]
        #expect(throws: (any Error).self) { try lock.enable(allowPasscode: false) }
        #expect(!lock.status().enabled && !lock.locked)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount) == nil)
        #expect(store.stored(service: Vault.service, account: Vault.dataKeyAccount) != nil)
        #expect(try vault.get(namespace: "session-direct", key: "h1") == "direct-token")
        store.failingWrites = []
        let relaunched = AppLock(vault: Vault(store: store, accessGroup: nil), biometry: { .available })
        #expect(!relaunched.status().enabled)
    }

    // F8: a process that died after the guarded copy was written but before the setting was saved.
    @Test func aProcessThatDiedBeforeTheSettingWasSavedComesBackUnlocked() throws {
        let (vault, store) = makeVault()
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .locked)
        try vault.guardDataKey(.biometryCurrentSet, prompt: "p")
        let fresh = Vault(store: store, accessGroup: nil)
        let relaunched = AppLock(vault: fresh, biometry: { .available })
        #expect(!relaunched.status().enabled && !relaunched.locked)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount) == nil)
        #expect(try fresh.get(namespace: "session-direct", key: "h1") == "direct-token")
    }

    // F8: a process that died after the setting was saved but before the plain copy went.
    @Test func aProcessThatDiedAfterTheSettingWasSavedComesBackLocked() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .locked)
        store.failingDeletes = [Vault.dataKeyAccount]
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        store.failingDeletes = []
        #expect(store.stored(service: Vault.service, account: Vault.dataKeyAccount) != nil, "the stage the test stands for")
        let fresh = Vault(store: store, accessGroup: nil)
        let relaunched = AppLock(vault: fresh, biometry: { .available })
        #expect(relaunched.status().enabled && relaunched.locked)
        #expect(store.stored(service: Vault.service, account: Vault.dataKeyAccount) == nil, "no plain key bypasses the lock")
        #expect(throws: VaultError.locked) { try fresh.get(namespace: "session-direct", key: "h1") }
        #expect(try relaunched.unlock() == .unlocked)
        #expect(try fresh.get(namespace: "session-direct", key: "h1") == "direct-token")
    }

    // F8: a disable whose setting cannot be saved keeps the lock, and its key.
    @Test func aDisableWhoseSettingCannotBeSavedKeepsTheLock() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .locked)
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        store.failingWrites = ["meta.applock"]
        #expect(throws: (any Error).self) { try lock.disable() }
        store.failingWrites = []
        #expect(lock.status().enabled)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount) != nil)
        #expect(store.stored(service: Vault.service, account: Vault.dataKeyAccount) == nil)
        let fresh = Vault(store: store, accessGroup: nil)
        let relaunched = AppLock(vault: fresh, biometry: { .available })
        #expect(relaunched.locked)
        #expect(try relaunched.unlock() == .unlocked)
        #expect(try fresh.get(namespace: "session-direct", key: "h1") == "direct-token")
    }

    // F4: a lock an older build enabled never promoted its session entries.
    @Test func aLockEnabledByAnOlderBuildRefusesThenPromotesLegacySessions() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        // What the older build wrote while unlocked, after its lock was on.
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .standard)
        try vault.set(namespace: "session-direct", key: "names", value: "a.example.com", protection: .standard)
        try vault.set(namespace: "session", key: "h2", value: "access-jwt", protection: .standard)
        let fresh = Vault(store: store, accessGroup: nil)
        let relaunched = AppLock(vault: fresh, biometry: { .available })
        #expect(throws: VaultError.locked) { try fresh.get(namespace: "session-direct", key: "h1") }
        #expect(throws: VaultError.locked) { try fresh.get(namespace: "session", key: "h2") }
        #expect(try fresh.get(namespace: "session-direct", key: "names") == "a.example.com")
        #expect(try relaunched.unlock() == .unlocked)
        #expect(try fresh.get(namespace: "session-direct", key: "h1") == "direct-token")
        let item = KeychainItem(service: Vault.service, account: "ns.session-direct", access: .whenUnlockedThisDeviceOnly)
        let raw = String(decoding: try #require(try store.read(item, prompt: nil)), as: UTF8.self)
        #expect(!raw.contains("direct-token"), "promoted into the sealed class at the unlock")
    }

    // Round 4: the biometric set changes before any unlock could promote them.
    @Test func anInvalidationBeforePromotionDropsLegacySessions() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        try vault.set(namespace: "session-direct", key: "h1", value: "direct-token", protection: .standard)
        try vault.set(namespace: "session-direct", key: "names", value: "a.example.com", protection: .standard)
        try vault.set(namespace: "session", key: "h2", value: "access-jwt", protection: .standard)
        try vault.set(namespace: "orgs", key: "list", value: "[]", protection: .standard)
        store.drop(service: Vault.service, account: Vault.guardedKeyAccount)
        let fresh = Vault(store: store, accessGroup: nil)
        #expect(try AppLock(vault: fresh, biometry: { .available }).unlock() == .invalidated)
        #expect(try fresh.list(namespace: "session-direct") == ["names"])
        #expect(try fresh.list(namespace: "session").isEmpty)
        #expect(try fresh.get(namespace: "session-direct", key: "names") == "a.example.com")
        #expect(try fresh.get(namespace: "orgs", key: "list") == "[]")
    }

    @Test func invalidationWipesLockedAndKeepsStandard() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "s", key: "token", value: "t", protection: .locked)
        try vault.set(namespace: "s", key: "name", value: "n", protection: .standard)
        _ = try lock.enable(allowPasscode: false)
        lock.engage()
        store.drop(service: Vault.service, account: Vault.guardedKeyAccount)
        #expect(try lock.unlock() == .invalidated)
        #expect(!lock.locked && lock.status().enabled)
        #expect(try vault.get(namespace: "s", key: "token") == nil)
        #expect(try vault.get(namespace: "s", key: "name") == "n")
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount)?.guardedBy == .biometryCurrentSet)
    }

    @Test func enableCancelledLeavesLockOff() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "s", key: "token", value: "t", protection: .locked)
        store.guardedReadFailure = .cancelled
        #expect(try lock.enable(allowPasscode: true) == .cancelled)
        #expect(!lock.status().enabled)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount) == nil)
        #expect(try vault.get(namespace: "s", key: "token") == "t")
    }

    @Test func enableWithoutBiometryNeedsPasscodeFallback() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .noneEnrolled })
        #expect(try lock.enable(allowPasscode: false) == .unavailable)
        #expect(try lock.enable(allowPasscode: true) == .enabled)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount)?.guardedBy == .userPresence)
    }

    @Test func disableMovesKeyBack() throws {
        let (vault, store) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        try vault.set(namespace: "s", key: "token", value: "t", protection: .locked)
        _ = try lock.enable(allowPasscode: false)
        #expect(try lock.disable() == .disabled)
        #expect(store.stored(service: Vault.service, account: Vault.guardedKeyAccount) == nil)
        lock.engage()
        #expect(!lock.locked)
        #expect(try vault.get(namespace: "s", key: "token") == "t")
    }

    @Test func graceIsMeasuredFromBackground() {
        let (vault, _) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        _ = try? lock.enable(allowPasscode: false)
        lock.didEnterBackground(nowMs: 1_000)
        #expect(!lock.willEnterForeground(nowMs: 30_000))
        lock.didEnterBackground(nowMs: 1_000)
        #expect(lock.willEnterForeground(nowMs: 61_000))
    }

    @Test func anExternalFlowHoldsTheLockOpenUntilItEndsOrItsTtl() throws {
        let (vault, _) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        try lock.setOptions(grace: .immediately, allowPasscode: nil)
        lock.holdForExternalFlow(ttlMs: 600_000, nowMs: 1_000)
        lock.didEnterBackground(nowMs: 2_000)
        #expect(!lock.willEnterForeground(nowMs: 300_000), "back from the app's own sign-in browser")
        lock.releaseExternalFlow()
        lock.didEnterBackground(nowMs: 400_000)
        #expect(lock.willEnterForeground(nowMs: 400_000), "released: the background lock applies again")

        #expect(try lock.unlock() == .unlocked)
        lock.holdForExternalFlow(ttlMs: 600_000, nowMs: 1_000_000)
        lock.didEnterBackground(nowMs: 1_000_000)
        #expect(lock.willEnterForeground(nowMs: 1_600_001), "a hold nobody released expires with its TTL")
        #expect(try lock.unlock() == .unlocked)
        lock.didEnterBackground(nowMs: 1_100_000)
        #expect(lock.willEnterForeground(nowMs: 999_999), "a clock that went backwards is outside the hold")
    }

    @Test func anUnlockVoidsTheBackgroundMark() throws {
        let (vault, _) = makeVault()
        let lock = AppLock(vault: vault, biometry: { .available })
        _ = try lock.enable(allowPasscode: false)
        try lock.setOptions(grace: .immediately, allowPasscode: nil)
        lock.engage()
        lock.didEnterBackground(nowMs: 1_000)
        #expect(try lock.unlock() == .unlocked)
        #expect(!lock.willEnterForeground(nowMs: 90_000))
    }

    @Test(arguments: [
        (nil, 5_000, LockGrace.immediately, false),
        (1_000, 1_000, .immediately, true),
        (1_000, 60_999, .oneMinute, false),
        (1_000, 61_000, .oneMinute, true),
        (0, 299_999, .fiveMinutes, false),
        (0, 300_000, .fiveMinutes, true),
        (0, 899_999, .fifteenMinutes, false),
        (0, 900_000, .fifteenMinutes, true),
        (10_000, 9_000, .fifteenMinutes, true)
    // A Swift Testing argument table: one row per case, matching the test's four parameters.
    // swiftlint:disable:next large_tuple
    ] as [(Int64?, Int64, LockGrace, Bool)])
    func shouldLockTable(backgroundedAt: Int64?, now: Int64, grace: LockGrace, expected: Bool) {
        #expect(AppLock.shouldLock(backgroundedAtMs: backgroundedAt, nowMs: now, grace: grace) == expected)
    }
}
