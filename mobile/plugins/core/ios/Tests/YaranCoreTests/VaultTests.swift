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

    @Test(arguments: [
        (nil, 5_000, LockGrace.immediately, false),
        (1_000, 1_000, .immediately, true),
        (1_000, 60_999, .oneMinute, false),
        (1_000, 61_000, .oneMinute, true),
        (0, 299_999, .fiveMinutes, false),
        (0, 300_000, .fiveMinutes, true),
        (0, 899_999, .fifteenMinutes, false),
        (0, 900_000, .fifteenMinutes, true),
        (10_000, 9_000, .fifteenMinutes, true),
    ] as [(Int64?, Int64, LockGrace, Bool)])
    func shouldLockTable(backgroundedAt: Int64?, now: Int64, grace: LockGrace, expected: Bool) {
        #expect(AppLock.shouldLock(backgroundedAtMs: backgroundedAt, nowMs: now, grace: grace) == expected)
    }
}
