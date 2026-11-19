/// Tests for the install id, the D24 device key unit and the per-host session store.
///
/// Covers distinct keys per org, the remint-both rule in both directions, signing that
/// verifies through `HandoffSignature`, the minting diagnostics line (level and fingerprint,
/// never the key), JWT `exp` cross-checking, the locked class, and org wipes that leave other
/// orgs untouched.
///
/// - In-memory vault and a CryptoKit software key backend.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/StoreTests
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffSignature (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/Fakes (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/StoreTests
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// └── MachineViewCoreTests/OrgWipeTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation
import Testing
@testable import MachineViewCore

struct StoreRig {
    let vault = MemoryVault(), diag = MemoryDiag(), backend = SoftwareKeyBackend(), cleaner = FakeCleaner()
    var lock = false
    var installs: InstallIdStore { InstallIdStore(vault: vault) }
    var keys: DeviceKeyStore { DeviceKeyStore(backend: backend, installs: installs, diagnostics: diag) }
    func sessions() -> SessionStore { SessionStore(vault: vault, diagnostics: diag) }
}

func payload(host: String, exp: Int64, jwtExp: Int64? = nil, cookie: String? = nil, kind: String = "machine") -> HandoffPayload {
    HandoffPayload(kind: kind, host: host, jwt: Sealer.jwt(exp: jwtExp ?? exp), email: "ada@example.org", exp: exp, iat: 1000, cookie: cookie)
}

@Suite struct StoreTests {
    @Test func installIdIsUuidV4AndRegisteredFlagPersists() throws {
        let rig = StoreRig()
        let id = try rig.keys.ensure("org-a")
        #expect(Pattern.installId.matches(id.installId))
        #expect(try rig.installs.get("org-a")?.registered == false)
        try rig.installs.markRegistered("org-a")
        #expect(try rig.installs.get("org-a")?.registered == true)
        #expect(rig.vault.items["install/org-a"]?.1 == .standard)
    }

    @Test func twoOrgsGetDifferentKeysAndEnsureIsStable() throws {
        let rig = StoreRig()
        let first = try rig.keys.ensure("org-a"), second = try rig.keys.ensure("org-b")
        #expect(first.publicKey != second.publicKey && first.installId != second.installId)
        #expect(try rig.keys.ensure("org-a") == first)
        #expect(P256Point.decode(first.publicKey) != nil)
    }

    @Test func missingKeyRemintsBoth() throws {
        let rig = StoreRig()
        let first = try rig.keys.ensure("org-a")
        rig.backend.delete("yaran.device.org-a")
        let second = try rig.keys.ensure("org-a")
        #expect(first.installId != second.installId && first.publicKey != second.publicKey)
        #expect(rig.diag.lines.contains { $0.contains("reminted") && $0.contains("key_missing") })
    }

    @Test func missingInstallIdRemintsBoth() throws {
        let rig = StoreRig()
        let first = try rig.keys.ensure("org-a")
        try rig.installs.delete("org-a")
        let second = try rig.keys.ensure("org-a")
        #expect(first.publicKey != second.publicKey)
    }

    @Test func signatureVerifiesAndMintingLogsLevelNotKey() throws {
        let rig = StoreRig()
        rig.backend.level = .secureEnclave
        let id = try rig.keys.ensure("org-a")
        let canonical = HandoffSignature.canonical(host: "h.example.com", pk: "pk", state: "s", dts: 5)
        let raw = try #require(B64url.decode(try rig.keys.sign("org-a", canonical)))
        let key = try P256.Signing.PublicKey(x963Representation: P256Point.decode(id.publicKey)!)
        #expect(key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: raw), for: Data(canonical.utf8)))
        let line = try #require(rig.diag.lines.first { $0.contains("device key minted") })
        let fingerprint = HandoffSignature.displayFingerprint(HandoffSignature.fingerprint24(point: P256Point.decode(id.publicKey)!))
        #expect(line.contains("level=secure_enclave") && line.contains("fp=\(fingerprint)"))
        #expect(expectClean(rig.diag.lines, [id.publicKey]))
        #expect(rig.keys.level("org-a") == .secureEnclave)
    }

    @Test func sessionExpIsTheSmallerOfPayloadAndJwt() throws {
        let rig = StoreRig()
        let stored = try rig.sessions().put(orgId: "org-a", payload: payload(host: "m.example.com", exp: 5000, jwtExp: 4000), kind: .accessJwt)
        #expect(stored.exp == 4000)
        #expect(rig.sessions().status("m.example.com", now: 3999) == (true, 4000))
        #expect(rig.sessions().status("m.example.com", now: 4000) == (false, 4000))
        #expect(rig.sessions().status("x.example.com", now: 0) == (false, nil))
    }

    @Test func undecodableJwtExpFallsBackToPayloadWithDiagnostic() throws {
        let rig = StoreRig()
        let given = HandoffPayload(kind: "machine", host: "m.example.com", jwt: "a.b.c", email: "a@b.c", exp: 5000, iat: 1, cookie: nil)
        #expect(try rig.sessions().put(orgId: "o", payload: given, kind: .accessJwt).exp == 5000)
        #expect(rig.diag.lines.contains { $0.contains("jwt exp undecodable") })
    }

    @Test func lockedClassEvenWithAppLockOff() throws {
        let rig = StoreRig()
        try rig.sessions().put(orgId: "org-a", payload: payload(host: "m.example.com", exp: 5000), kind: .accessJwt)
        #expect(rig.vault.items["session/m.example.com"]?.1 == .locked)
        rig.vault.locked = true
        #expect(throws: VaultError.locked) { try rig.sessions().get("m.example.com") }
    }

    @Test func wipeTouchesOnlyThatOrg() throws {
        let rig = StoreRig()
        let store = rig.sessions()
        try store.put(orgId: "org-a", payload: payload(host: "a1.example.com", exp: 9000), kind: .accessJwt)
        try store.put(orgId: "org-a", payload: payload(host: "cp.example.com", exp: 9000), kind: .accessJwt)
        try store.put(orgId: "org-b", payload: payload(host: "b1.example.com", exp: 9000), kind: .accessJwt)
        try rig.keys.ensure("org-a"); try rig.keys.ensure("org-b")
        try store.wipe(orgId: "org-a", extraHosts: ["gone.example.com"], deviceKeys: rig.keys, cleaner: rig.cleaner)
        #expect(try store.hosts(orgId: "org-a").isEmpty)
        #expect(try store.hosts(orgId: "org-b") == ["b1.example.com"])
        #expect(rig.cleaner.cleared == [["a1.example.com", "cp.example.com", "gone.example.com"]])
        #expect(try rig.installs.get("org-a") == nil && !rig.backend.exists("yaran.device.org-a"))
        #expect(try rig.installs.get("org-b") != nil && rig.backend.exists("yaran.device.org-b"))
    }

    @Test func storedSessionDescriptionHidesCredentials() throws {
        let rig = StoreRig()
        let stored = try rig.sessions().put(orgId: "o", payload: payload(host: "m.example.com", exp: 5000, cookie: "c.o.k"), kind: .accessCookie)
        #expect(!String(describing: stored).contains(stored.jwt) && !String(describing: stored).contains("c.o.k"))
    }
}
