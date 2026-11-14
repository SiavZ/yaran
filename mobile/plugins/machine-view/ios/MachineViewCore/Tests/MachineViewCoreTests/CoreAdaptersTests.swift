/// Tests for CoreAdapters: this plugin's vault names over Phase 14's real `YaranCore.Vault`.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/CoreAdaptersTests
/// ├── MachineViewCore/CoreAdapters (inferred)
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
