/// KeychainWriteTests: the order of Security framework calls `SystemKeychainStore.write` makes
/// (Sol native review round 4), through its `SecItemCalls` seam with no Keychain behind it.
///
/// An unguarded item is updated in place and added only when missing, so a write that fails
/// never deleted the value first; only the guarded lock key is deleted and re-added. This proves
/// the call sequence, not the real Keychain's answers: those are the hosted AppTests' job.
///
/// <module-headers:begin>
/// Uses:
/// YaranCoreTests/KeychainWriteTests
/// └── YaranCore/KeychainStore (inferred)
/// External: Foundation, Security, Testing
///
/// Used by: entry point (Swift Testing, via bash mobile/plugins/core/ios/test.sh)
/// <module-headers:end>

import Foundation
import Security
import Testing
@testable import YaranCore

private final class Calls: @unchecked Sendable {
    var log: [String] = []
    var updateStatus: OSStatus = errSecSuccess
    var added: [String: Any]?

    var seam: SecItemCalls {
        SecItemCalls(add: { query in
            self.log.append("add")
            self.added = query as? [String: Any]
            return errSecSuccess
        }, update: { _, _ in
            self.log.append("update")
            return self.updateStatus
        }, delete: { _ in
            self.log.append("delete")
            return errSecSuccess
        })
    }
}

struct KeychainWriteTests {
    private let item = KeychainItem(service: "s", account: "a", access: .whenUnlockedThisDeviceOnly)

    @Test func aFailedUpdateDeletesNothing() {
        let calls = Calls()
        calls.updateStatus = errSecInteractionNotAllowed
        #expect(throws: KeychainFailure.unavailable) { try SystemKeychainStore(calls: calls.seam).write(Data([1]), to: item) }
        #expect(calls.log == ["update"])
    }

    @Test func anExistingItemIsUpdatedInPlace() throws {
        let calls = Calls()
        try SystemKeychainStore(calls: calls.seam).write(Data([1]), to: item)
        #expect(calls.log == ["update"])
    }

    @Test func aMissingItemIsAddedWithItsAccessClass() throws {
        let calls = Calls()
        calls.updateStatus = errSecItemNotFound
        try SystemKeychainStore(calls: calls.seam).write(Data([7]), to: item)
        #expect(calls.log == ["update", "add"])
        #expect(calls.added?[kSecValueData as String] as? Data == Data([7]))
        #expect(calls.added?[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    }

    @Test func theGuardedLockKeyIsReplaced() throws {
        let calls = Calls()
        let guarded = KeychainItem(service: "s", account: "lock", access: .whenPasscodeSetThisDeviceOnly, guardedBy: .userPresence)
        try SystemKeychainStore(calls: calls.seam).write(Data([1]), to: guarded)
        #expect(calls.log == ["delete", "add"])
        #expect(calls.added?[kSecAttrAccessControl as String] != nil)
    }
}
