/// OrgWipeTests: an org's wipe never calls itself done while a session of it may be left (Sol native
/// review round 12). `SessionStore.wipe` is what `Session.signOut` and the org API's
/// `device_revoked` both call. A listing that fails, or one record that cannot be read, throws with
/// nothing deleted, no host cleared and the device identity kept for a retry; the retry finishes.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/OrgWipeTests
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/OrgWipeTests
/// └── MachineViewCoreTests/DirectTests (inferred)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

/// A vault whose listing, or one record, can be made to fail as a broken Keychain would.
private final class FailingVault: SecretVault {
    let inner = MemoryVault()
    var failList = false
    var failRead: String?
    func read(_ path: String) throws -> Data? {
        if path == failRead { throw VaultError.unavailable }
        return try inner.read(path)
    }
    func write(_ path: String, _ value: Data, _ cls: ProtectionClass) throws { try inner.write(path, value, cls) }
    func delete(_ path: String) throws { try inner.delete(path) }
    func list(prefix: String) throws -> [String] {
        if failList { throw VaultError.unavailable }
        return try inner.list(prefix: prefix)
    }
}

struct OrgWipeTests {
    @Test func aWipeThatCannotFindEverySessionDeletesNothing() throws {
        let vault = FailingVault()
        let sessions = SessionStore(vault: vault, diagnostics: nil)
        let exp: Int64 = 9_999_999_999
        for host in ["a.example.com", "b.example.com"] {
            try sessions.put(orgId: "org-a", payload: payload(host: host, exp: exp, kind: "machine"), kind: .accessJwt)
        }
        let installs = InstallIdStore(vault: vault)
        let keys = DeviceKeyStore(backend: SoftwareKeyBackend(), installs: installs, diagnostics: nil)
        let identity = try keys.ensure("org-a").installId
        let cleaner = FakeCleaner()

        for fail in [{ vault.failList = true }, { vault.failRead = SessionStore.prefix + "b.example.com" }] {
            fail()
            #expect(throws: (any Error).self) { try sessions.wipe(orgId: "org-a", deviceKeys: keys, cleaner: cleaner) }
            vault.failList = false
            vault.failRead = nil
            #expect(try sessions.get("a.example.com") != nil && sessions.get("b.example.com") != nil, "nothing deleted")
            #expect(try keys.ensure("org-a").installId == identity, "the device identity stays for a retry")
            #expect(cleaner.cleared.isEmpty)
        }

        try sessions.wipe(orgId: "org-a", deviceKeys: keys, cleaner: cleaner)
        #expect(try sessions.get("a.example.com") == nil && sessions.get("b.example.com") == nil)
        #expect(cleaner.cleared == [["a.example.com", "b.example.com"]])
        #expect(try keys.ensure("org-a").installId != identity, "the old identity went with the finished wipe")
    }

    /// The plugin reports the two endings apart (type-checked, not run here).
    @Test func thePluginSaysAnUnfinishedSignOutApartFromALockedOne() throws {
        let plugin = try String(contentsOf: Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView/SessionPlugin.swift"),
                                encoding: .utf8)
        #expect(plugin.contains("} catch VaultError.locked {\n                call.reject(\"Unlock the app to sign out.\", \"vault_locked\")"))
        #expect(plugin.contains("call.reject(\"the sign-out did not finish\", \"native_error\")"))
    }
}
