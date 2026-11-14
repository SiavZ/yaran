/// Test doubles for the Phase 14 seams, the key backend, the launcher and the scheduler.
///
/// `MemoryVault` records protection classes, `SoftwareKeyBackend` is a CryptoKit key per
/// alias, `Sealer` seals a handoff envelope the way the servers do, so the client can be
/// driven end to end without a browser.
///
/// - Test-only.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/Fakes
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// MachineViewCoreTests/Fakes
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// ├── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation
@testable import MachineViewCore

final class MemoryVault: SecretVault {
    var items: [String: (Data, ProtectionClass)] = [:]
    var locked = false
    func read(_ ns: String) throws -> Data? {
        if locked, items[ns]?.1 == .locked { throw VaultError.locked }
        return items[ns]?.0
    }
    func write(_ ns: String, _ value: Data, _ cls: ProtectionClass) throws { items[ns] = (value, cls) }
    func delete(_ ns: String) throws { items[ns] = nil }
    func list(prefix: String) throws -> [String] { items.keys.filter { $0.hasPrefix(prefix) }.sorted() }
    func json(_ ns: String) -> [String: Any]? { items[ns].flatMap { try? JSONSerialization.jsonObject(with: $0.0) as? [String: Any] } }
}

final class MemoryDiag: DiagnosticsSink {
    var lines: [String] = []
    func append(_ line: String) { lines.append(line) }
}

final class FakeOrgs: OrgDirectory {
    var urls: [String: String] = ["org-a": "https://cp.example.com", "org-b": "https://cp-b.example.com"]
    func orgUrl(_ orgId: String) -> String? { urls[orgId] }
}

final class FakeCleaner: WebDataCleaner {
    var cleared: [[String]] = []
    func clear(hosts: [String]) { cleared.append(hosts) }
}

final class SoftwareKeyBackend: DeviceKeyBackend {
    var keys: [String: P256.Signing.PrivateKey] = [:]
    var level: SecurityLevel = .software
    func exists(_ alias: String) -> Bool { keys[alias] != nil }
    func generate(_ alias: String) throws -> SecurityLevel { keys[alias] = P256.Signing.PrivateKey(); return level }
    func publicPoint(_ alias: String) throws -> Data { keys[alias]!.publicKey.x963Representation }
    func signDer(_ alias: String, _ data: Data) throws -> Data { try keys[alias]!.signature(for: data).derRepresentation }
    func delete(_ alias: String) { keys[alias] = nil }
}

final class FakeLauncher: HandoffLauncher {
    var launched: [(URL, CallbackMode)] = []
    var completions: [(LauncherResult) -> Void] = []
    func launch(url: URL, mode: CallbackMode, completion: @escaping (LauncherResult) -> Void) {
        launched.append((url, mode)); completions.append(completion)
    }
    var lastQuery: [String: String] {
        let items = URLComponents(url: launched.last!.0, resolvingAgainstBaseURL: false)!.queryItems!
        return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value!) })
    }
}

enum Sealer {
    /// Seals `payload` to `pk` for `host`/`state` (ECDH-ES + Concat KDF + A256GCM), like 06/11 do.
    static func seal(pk: String, host: String, state: String, payload: [String: Any]) throws -> String {
        let point = P256Point.decode(pk)!
        let eph = P256.KeyAgreement.PrivateKey()
        let epk = eph.publicKey.x963Representation
        let header: [String: Any] = [
            "alg": "ECDH-ES", "enc": "A256GCM", "typ": "yaran-handoff+jwe", "cty": "yaran-handoff+json",
            "kid": SealedEnvelope.thumbprint(point: point),
            "epk": ["kty": "EC", "crv": "P-256", "x": B64url.encode(epk.subdata(in: 1..<33)), "y": B64url.encode(epk.subdata(in: 33..<65))],
            "apu": B64url.encode(Data(host.utf8)), "apv": B64url.encode(Data(state.utf8)),
        ]
        let h = B64url.encode(try JSONSerialization.data(withJSONObject: header))
        let z = try eph.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: point)).withUnsafeBytes { Data($0) }
        let cek = ConcatKdf.derive(z: z, algorithmId: "A256GCM", apu: Data(host.utf8), apv: Data(state.utf8), keyBits: 256)
        let box = try AES.GCM.seal(try JSONSerialization.data(withJSONObject: payload), using: SymmetricKey(data: cek),
                                   nonce: AES.GCM.Nonce(), authenticating: Data(h.utf8))
        return [h, "", B64url.encode(Data(box.nonce)), B64url.encode(box.ciphertext), B64url.encode(box.tag)].joined(separator: ".")
    }

    static func jwt(exp: Int64) -> String {
        "eyJhbGciOiJSUzI1NiJ9." + B64url.encode(try! JSONSerialization.data(withJSONObject: ["exp": exp])) + ".c2ln"
    }
}

final class FakeScheduler: OneShotScheduler {
    final class Handle: Cancellable { var cancelled = false; func cancel() { cancelled = true } }
    var scheduled: [(Int64, () -> Void, Handle)] = []
    func schedule(at: Int64, _ fire: @escaping () -> Void) -> Cancellable {
        let h = Handle(); scheduled.append((at, fire, h)); return h
    }
    var live: (Int64, () -> Void)? { scheduled.last { !$0.2.cancelled }.map { ($0.0, $0.1) } }
}

final class FakeUi: RenewalUi {
    var events: [String] = []
    func showBanner() { events.append("banner") }
    func hideBanner() { events.append("hideBanner") }
    func showReauthOverlay() { events.append("overlay") }
    func hideOverlay() { events.append("hideOverlay") }
    func reloadSameUrl() { events.append("reload") }
}

/// Asserts no diagnostics line carries a credential or a query string.
func expectClean(_ lines: [String], _ secrets: [String] = []) -> Bool {
    lines.allSatisfy { line in
        !line.contains("eyJ") && !line.contains("?") && !line.contains("jwe=") && secrets.allSatisfy { !line.contains($0) }
    }
}
