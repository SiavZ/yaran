/// Per-host sessions in vault namespace `session/<host>` (D22: JWTs never reach JS).
///
/// A successful handoff stores `{org_id, jwt, cookie?, exp, iat, email, credential_kind}` in
/// the `locked` class when App Lock is on. `exp` is the smaller of the payload's `exp` and the
/// JWT's own (decoded, not verified: it came sealed from the authenticated host). Wiping an
/// org deletes every session it owns, the WebView data for those hosts, its `install_id` and
/// its device key.
///
/// - The vault is the only place a JWT rests; the WebView cookie is a session cookie.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/SessionStore
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/SessionStore
/// ├── MachineView/AppServices (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// ├── MachineViewCoreTests/OrgWipeTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public struct StoredSession: Codable, Equatable, CustomStringConvertible {
    public let orgId: String
    public let jwt: String
    public let cookie: String?
    public let exp: Int64
    public let iat: Int64
    public let email: String
    public let credentialKind: CredentialKind

    public var description: String { "StoredSession(org: \(orgId), exp: \(exp))" }

    enum CodingKeys: String, CodingKey {
        case orgId = "org_id", jwt, cookie, exp, iat, email, credentialKind = "credential_kind"
    }
}

public final class SessionStore {
    private let vault: SecretVault
    private let diagnostics: DiagnosticsSink?

    public init(vault: SecretVault, diagnostics: DiagnosticsSink?) {
        (self.vault, self.diagnostics) = (vault, diagnostics)
    }

    static let prefix = "session/"

    @discardableResult
    public func put(orgId: String, payload: HandoffPayload, kind: CredentialKind) throws -> StoredSession {
        var exp = payload.exp
        if let jwtExp = Self.jwtExp(payload.jwt) {
            exp = min(exp, jwtExp)
        } else {
            diagnostics?.append(diagLine("jwt exp undecodable", [("host", payload.host)]))
        }
        let session = StoredSession(orgId: orgId, jwt: payload.jwt, cookie: payload.cookie, exp: exp, iat: payload.iat,
                                    email: payload.email, credentialKind: kind)
        // Locked class from creation: enabling App Lock later must not leave this bearer readable.
        try vault.write(Self.prefix + payload.host, JSONEncoder().encode(session), .locked)
        return session
    }

    /// The session, or nil when there is none. Throws `VaultError.locked` while locked and
    /// `StoredRecordError.unreadable` for a record that is there but cannot be read: that is
    /// never "signed out" (the window says so instead of starting a sign-in by itself).
    public func get(_ host: String) throws -> StoredSession? {
        let data: Data?
        do { data = try vault.read(Self.prefix + host) } catch VaultError.locked { throw VaultError.locked } catch { throw StoredRecordError.unreadable }
        guard let data else { return nil }
        guard let session = try? JSONDecoder().decode(StoredSession.self, from: data) else { throw StoredRecordError.unreadable }
        return session
    }

    /// Only a session of `orgId`: another org's session for the same host is no session for this route.
    public func get(_ host: String, orgId: String) throws -> StoredSession? {
        try get(host).flatMap { $0.orgId == orgId ? $0 : nil }
    }

    public func status(_ host: String, now: Int64) -> (signedIn: Bool, expiresAt: Int64?) {
        guard let stored = try? get(host) else { return (false, nil) }
        return (stored.exp > now, stored.exp)
    }

    /// Every host holding a session of `orgId`. A listing or a record that cannot be read throws: an
    /// unreadable record may be this org's, so "none" would be a guess that leaves it behind.
    public func hosts(orgId: String) throws -> [String] {
        try vault.list(prefix: Self.prefix).compactMap { path in
            let host = String(path.dropFirst(Self.prefix.count))
            return try get(host)?.orgId == orgId ? host : nil
        }
    }

    public func delete(hosts: [String]) throws {
        for host in hosts { try vault.delete(Self.prefix + host) }
    }

    /// Sign-out, `device_revoked` and org removal: sessions of `orgId` plus `extraHosts`,
    /// their WebView data, the `install_id` and the device key. Throws, with nothing deleted and the
    /// device identity kept for a retry, when the org's sessions cannot all be found.
    public func wipe(orgId: String, extraHosts: [String] = [], deviceKeys: DeviceKeyStore, cleaner: WebDataCleaner?) throws {
        let hosts = Array(Set(try self.hosts(orgId: orgId) + extraHosts)).sorted()
        try delete(hosts: hosts)
        cleaner?.clear(hosts: hosts)
        try deviceKeys.delete(orgId)
        diagnostics?.append(diagLine("org wiped", [("hosts", String(hosts.count))]))
    }

    /// The JWT payload's `exp`, decoded without verification.
    static func jwtExp(_ jwt: String) -> Int64? {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, let data = B64url.decode(String(parts[1])),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        return SealedEnvelope.integer(obj["exp"])
    }
}
