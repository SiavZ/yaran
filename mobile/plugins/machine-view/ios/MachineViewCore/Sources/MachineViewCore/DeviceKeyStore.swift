/// The per-org device key (D24): minted, used and deleted as one unit with the `InstallId`.
///
/// One P-256 signing key per org registration (alias `yaran.device.<orgId>`), never per
/// install, so two orgs cannot link the phone by its key. If either half is missing while the
/// other exists (a reinstall that kept Keychain items, a lost key), both are deleted and
/// reminted, so the Worker never sees a new key under an old `install_id`. Signing returns
/// the raw base64url `EcdsaP256Sig`; the private key never leaves the backend.
///
/// - Minting writes one diagnostics line with the security level and the fingerprint, never the key.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/DeviceKeyStore
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/HandoffSignature (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/DeviceKeyStore
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/SessionPlugin (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/SecureEnclaveBackend (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public protocol DeviceKeyBackend: AnyObject {
    func exists(_ alias: String) -> Bool
    /// Creates the key (hardware first, software fallback) and reports where it lives.
    func generate(_ alias: String) throws -> SecurityLevel
    /// The 65-byte uncompressed public point.
    func publicPoint(_ alias: String) throws -> Data
    /// ECDSA P-256 over SHA-256 of `data`, DER-encoded.
    func signDer(_ alias: String, _ data: Data) throws -> Data
    func delete(_ alias: String)
}

public struct DeviceIdentity: Equatable {
    public let installId: String
    /// The device public key as a P256Point string.
    public let publicKey: String
    public let level: SecurityLevel
}

public final class DeviceKeyStore {
    private let backend: DeviceKeyBackend
    private let installs: InstallIdStore
    private let diagnostics: DiagnosticsSink?

    public init(backend: DeviceKeyBackend, installs: InstallIdStore, diagnostics: DiagnosticsSink?) {
        (self.backend, self.installs, self.diagnostics) = (backend, installs, diagnostics)
    }

    static func alias(_ orgId: String) -> String { "yaran.device.\(orgId)" }

    /// The org's identity, minting or reminting both halves as needed.
    @discardableResult
    public func ensure(_ orgId: String) throws -> DeviceIdentity {
        let alias = Self.alias(orgId)
        let record = try installs.get(orgId)
        let hasKey = backend.exists(alias)
        if let record, hasKey {
            return DeviceIdentity(installId: record.installId, publicKey: B64url.encode(try backend.publicPoint(alias)),
                                  level: record.level ?? .software)
        }
        if record != nil || hasKey {
            diagnostics?.append(diagLine("device identity reminted", [("reason", hasKey ? "install_id_missing" : "key_missing")]))
            try delete(orgId)
        }
        let level = try backend.generate(alias)
        let point = try backend.publicPoint(alias)
        let minted = try installs.mint(orgId, level: level)
        diagnostics?.append(diagLine("device key minted", [
            ("level", level.rawValue),
            ("fp", HandoffSignature.displayFingerprint(HandoffSignature.fingerprint24(point: point))),
        ]))
        return DeviceIdentity(installId: minted.installId, publicKey: B64url.encode(point), level: level)
    }

    /// The stored public key, without minting.
    public func publicKey(_ orgId: String) -> String? {
        let alias = Self.alias(orgId)
        guard backend.exists(alias), let point = try? backend.publicPoint(alias) else { return nil }
        return B64url.encode(point)
    }

    public func level(_ orgId: String) -> SecurityLevel { (try? installs.get(orgId))?.level ?? .software }

    /// `dsig` over the canonical string.
    public func sign(_ orgId: String, _ canonical: String) throws -> String {
        B64url.encode(try HandoffSignature.derToRaw(backend.signDer(Self.alias(orgId), Data(canonical.utf8))))
    }

    public func delete(_ orgId: String) throws {
        backend.delete(Self.alias(orgId))
        try installs.delete(orgId)
    }
}
