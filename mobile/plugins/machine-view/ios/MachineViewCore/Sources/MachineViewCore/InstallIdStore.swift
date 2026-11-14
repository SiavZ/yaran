/// The per-org `InstallId` (Phase 02 §2) in vault namespace `install/<orgId>`.
///
/// One lowercase UUID v4 per org registration on this install, plus whether `POST
/// /v1/me/devices` has succeeded (after which every Worker call carries `Yaran-Install-Id`)
/// and the device key's security level for diagnostics. It is an identifier, not a credential,
/// and lives in the `standard` class so background work can reach it.
///
/// - Minted and deleted only together with the org's device key (`DeviceKeyStore`).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/InstallIdStore
/// ├── MachineViewCore/Outcomes (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/InstallIdStore
/// ├── MachineView/AppServices (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public struct InstallRecord: Codable, Equatable {
    public let installId: String
    public var registered: Bool
    public var level: SecurityLevel?

    enum CodingKeys: String, CodingKey {
        case installId = "install_id", registered, level
    }
}

public final class InstallIdStore {
    private let vault: SecretVault

    public init(vault: SecretVault) { self.vault = vault }

    static func namespace(_ orgId: String) -> String { "install/\(orgId)" }

    public func get(_ orgId: String) throws -> InstallRecord? {
        try vault.read(Self.namespace(orgId)).flatMap { try? JSONDecoder().decode(InstallRecord.self, from: $0) }
    }

    @discardableResult
    public func mint(_ orgId: String, level: SecurityLevel) throws -> InstallRecord {
        let record = InstallRecord(installId: UUID().uuidString.lowercased(), registered: false, level: level)
        try save(orgId, record)
        return record
    }

    public func markRegistered(_ orgId: String) throws {
        guard var record = try get(orgId), !record.registered else { return }
        record.registered = true
        try save(orgId, record)
    }

    public func delete(_ orgId: String) throws { try vault.delete(Self.namespace(orgId)) }

    private func save(_ orgId: String, _ record: InstallRecord) throws {
        try vault.write(Self.namespace(orgId), JSONEncoder().encode(record), .standard)
    }
}
