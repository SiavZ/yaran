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
/// └── MachineViewCoreTests/Fakes (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/StoreTests
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// └── MachineViewCoreTests/OrgApiClientTests (inferred)
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
    func sessions(lock: Bool = false) -> SessionStore { SessionStore(vault: vault, diagnostics: diag, lockEnabled: { lock }) }
}

func payload(host: String, exp: Int64, jwtExp: Int64? = nil, cookie: String? = nil, kind: String = "machine") -> HandoffPayload {
    HandoffPayload(kind: kind, host: host, jwt: Sealer.jwt(exp: jwtExp ?? exp), email: "ada@example.org", exp: exp, iat: 1000, cookie: cookie)
}

@Suite struct StoreTests {
    @Test func installIdIsUuidV4AndRegisteredFlagPersists() throws {
        let r = StoreRig()
        let id = try r.keys.ensure("org-a")
        #expect(Pattern.installId.matches(id.installId))
        #expect(try r.installs.get("org-a")?.registered == false)
        try r.installs.markRegistered("org-a")
        #expect(try r.installs.get("org-a")?.registered == true)
        #expect(r.vault.items["install/org-a"]?.1 == .standard)
    }

    @Test func twoOrgsGetDifferentKeysAndEnsureIsStable() throws {
        let r = StoreRig()
        let a = try r.keys.ensure("org-a"), b = try r.keys.ensure("org-b")
        #expect(a.publicKey != b.publicKey && a.installId != b.installId)
        #expect(try r.keys.ensure("org-a") == a)
        #expect(P256Point.decode(a.publicKey) != nil)
    }

    @Test func missingKeyRemintsBoth() throws {
        let r = StoreRig()
        let a = try r.keys.ensure("org-a")
        r.backend.delete("yaran.device.org-a")
        let b = try r.keys.ensure("org-a")
        #expect(a.installId != b.installId && a.publicKey != b.publicKey)
        #expect(r.diag.lines.contains { $0.contains("reminted") && $0.contains("key_missing") })
    }

    @Test func missingInstallIdRemintsBoth() throws {
        let r = StoreRig()
        let a = try r.keys.ensure("org-a")
        try r.installs.delete("org-a")
        let b = try r.keys.ensure("org-a")
        #expect(a.publicKey != b.publicKey)
    }

    @Test func signatureVerifiesAndMintingLogsLevelNotKey() throws {
        let r = StoreRig()
        r.backend.level = .secureEnclave
        let id = try r.keys.ensure("org-a")
        let canonical = HandoffSignature.canonical(host: "h.example.com", pk: "pk", state: "s", dts: 5)
        let raw = try #require(B64url.decode(try r.keys.sign("org-a", canonical)))
        let key = try P256.Signing.PublicKey(x963Representation: P256Point.decode(id.publicKey)!)
        #expect(key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: raw), for: Data(canonical.utf8)))
        let line = try #require(r.diag.lines.first { $0.contains("device key minted") })
        let fp = HandoffSignature.displayFingerprint(HandoffSignature.fingerprint24(point: P256Point.decode(id.publicKey)!))
        #expect(line.contains("level=secure_enclave") && line.contains("fp=\(fp)"))
        #expect(expectClean(r.diag.lines, [id.publicKey]))
        #expect(r.keys.level("org-a") == .secureEnclave)
    }

    @Test func sessionExpIsTheSmallerOfPayloadAndJwt() throws {
        let r = StoreRig()
        let s = try r.sessions().put(orgId: "org-a", payload: payload(host: "m.example.com", exp: 5000, jwtExp: 4000), kind: .accessJwt)
        #expect(s.exp == 4000)
        #expect(r.sessions().status("m.example.com", now: 3999) == (true, 4000))
        #expect(r.sessions().status("m.example.com", now: 4000) == (false, 4000))
        #expect(r.sessions().status("x.example.com", now: 0) == (false, nil))
    }

    @Test func undecodableJwtExpFallsBackToPayloadWithDiagnostic() throws {
        let r = StoreRig()
        let p = HandoffPayload(kind: "machine", host: "m.example.com", jwt: "a.b.c", email: "a@b.c", exp: 5000, iat: 1, cookie: nil)
        #expect(try r.sessions().put(orgId: "o", payload: p, kind: .accessJwt).exp == 5000)
        #expect(r.diag.lines.contains { $0.contains("jwt exp undecodable") })
    }

    @Test func lockedClassWhenAppLockIsOn() throws {
        let r = StoreRig()
        try r.sessions(lock: true).put(orgId: "org-a", payload: payload(host: "m.example.com", exp: 5000), kind: .accessJwt)
        #expect(r.vault.items["session/m.example.com"]?.1 == .locked)
        r.vault.locked = true
        #expect(throws: VaultError.locked) { try r.sessions().get("m.example.com") }
    }

    @Test func wipeTouchesOnlyThatOrg() throws {
        let r = StoreRig()
        let s = r.sessions()
        try s.put(orgId: "org-a", payload: payload(host: "a1.example.com", exp: 9000), kind: .accessJwt)
        try s.put(orgId: "org-a", payload: payload(host: "cp.example.com", exp: 9000), kind: .accessJwt)
        try s.put(orgId: "org-b", payload: payload(host: "b1.example.com", exp: 9000), kind: .accessJwt)
        try r.keys.ensure("org-a"); try r.keys.ensure("org-b")
        try s.wipe(orgId: "org-a", extraHosts: ["gone.example.com"], deviceKeys: r.keys, cleaner: r.cleaner)
        #expect(try s.hosts(orgId: "org-a").isEmpty)
        #expect(try s.hosts(orgId: "org-b") == ["b1.example.com"])
        #expect(r.cleaner.cleared == [["a1.example.com", "cp.example.com", "gone.example.com"]])
        #expect(try r.installs.get("org-a") == nil && !r.backend.exists("yaran.device.org-a"))
        #expect(try r.installs.get("org-b") != nil && r.backend.exists("yaran.device.org-b"))
    }

    @Test func storedSessionDescriptionHidesCredentials() throws {
        let r = StoreRig()
        let s = try r.sessions().put(orgId: "o", payload: payload(host: "m.example.com", exp: 5000, cookie: "c.o.k"), kind: .accessCookie)
        #expect(!String(describing: s).contains(s.jwt) && !String(describing: s).contains("c.o.k"))
    }
}
