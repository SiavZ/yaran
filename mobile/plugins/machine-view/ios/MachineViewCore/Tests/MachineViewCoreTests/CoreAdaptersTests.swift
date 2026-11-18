/// Tests for CoreAdapters: this plugin's vault names over Phase 14's real `YaranCore.Vault`.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/CoreAdaptersTests
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
import YaranCore
@testable import MachineViewCore

struct CoreAdaptersTests {
    private func vault() -> Vault { Vault(store: InMemoryKeychainStore(), accessGroup: nil) }

    @Test func namesLongerThanAVaultKeyRoundTripAndList() throws {
        let core = vault()
        let secrets = VaultSecrets(core)
        let long = String(repeating: "a", count: 60) + ".machines.example.com"
        let org = "https://cp.example.com"
        try secrets.write("session/\(long)", Data(#"{"jwt":"x"}"#.utf8), .locked)
        try secrets.write("session/m1.example.com", Data("{}".utf8), .standard)
        try secrets.write("install/\(org)", Data(#"{"install_id":"i"}"#.utf8), .standard)
        try secrets.write("handoff", Data(#"{"state":"s"}"#.utf8), .standard)

        #expect(try secrets.read("session/\(long)") == Data(#"{"jwt":"x"}"#.utf8))
        #expect(try secrets.list(prefix: "session/") == ["session/\(long)", "session/m1.example.com"])
        #expect(try secrets.list(prefix: "install/") == ["install/\(org)"])
        #expect(try secrets.read("handoff") == Data(#"{"state":"s"}"#.utf8))

        try secrets.delete("session/\(long)")
        #expect(try secrets.read("session/\(long)") == nil)
        try secrets.delete("session/m1.example.com")
        #expect(try secrets.list(prefix: "session/") == [])
        #expect(try core.list(namespace: "session") == [])
    }

    // Round 4: a replacement that throws replaced nothing, wherever the Keychain breaks (before
    // the fix, one write in was after the record and before the index), so keep() revokes only
    // the new token and the kept session is still the one stored.
    @Test func aReplacementThatFailsPartWayKeepsTheOldSession() throws {
        func session(_ token: String) -> DirectSession {
            DirectSession(host: "a.example.com", token: token, cookieName: "yaran_session_443", instance: "i1", issuedAt: 1, signInId: token + "_id")
        }
        for writes in 0...2 {
            let keychain = InMemoryKeychainStore()
            let secrets = VaultSecrets(Vault(store: keychain, accessGroup: nil))
            let store = DirectSessionStore(vault: secrets)
            try store.put(session("tokA"))
            keychain.writesBeforeFailure = writes
            let replaced = (try? store.put(session("tokB"))) != nil
            keychain.writesBeforeFailure = nil
            #expect(try store.get("a.example.com")?.token == (replaced ? "tokB" : "tokA"), "after \(writes) writes")
            #expect(try secrets.list(prefix: "session-direct/") == ["session-direct/a.example.com"])
        }
    }

    // Over the real YaranCore vault and App Lock: a direct token is never readable once the lock
    // is on, whether it was written after this fix (locked from creation) or by an older build.
    @Test func directSessionsAreUnreadableOnceTheLockIsEnabled() throws {
        let core = vault()
        let secrets = VaultSecrets(core)
        try DirectSessionStore(vault: secrets).put(DirectSession(host: "a.example.com", token: "tokA", cookieName: "yaran_session_443",
                                                                  instance: "i1", issuedAt: 1))
        let legacy = DirectSession(host: "b.example.com", token: "tokB", cookieName: "yaran_session_443", instance: "i1", issuedAt: 1)
        try secrets.write("session-direct/b.example.com", JSONEncoder().encode(legacy), .standard)
        let lock = AppLock(vault: core, biometry: { .available })
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        lock.engage()
        for host in ["a.example.com", "b.example.com"] {
            #expect(throws: MachineViewCore.VaultError.locked) { try DirectSessionStore(vault: secrets).get(host) }
        }
    }

    @Test func aValueThatIsNotUtf8IsRefusedAndNothingIsStored() throws {
        let secrets = VaultSecrets(vault())
        #expect(throws: YaranCore.VaultError.invalidArgument) { try secrets.write("handoff", Data([0x7b, 0xff, 0x7d]), .standard) }
        #expect(try secrets.read("handoff") == nil)
    }

    @Test func orgDirectoryReadsOnlyOnboardedOrgs() throws {
        let core = vault()
        let orgs = OrgList(core)
        #expect(orgs.orgUrl("https://cp.example.com") == nil)
        try core.set(namespace: "orgs", key: "list", value: #"[{"id":"https://cp.example.com","name":"Ada","teamDomain":null,"addedAt":"x"}]"#, protection: .standard)
        #expect(orgs.orgUrl("https://cp.example.com") == "https://cp.example.com")
        #expect(orgs.orgUrl("https://evil.example.com") == nil)
        try core.set(namespace: "orgs", key: "list", value: "not json", protection: .standard)
        #expect(orgs.orgUrl("https://cp.example.com") == nil)
    }
}
