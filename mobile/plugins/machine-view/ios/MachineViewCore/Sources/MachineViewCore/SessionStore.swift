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
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/SessionStore
/// ├── MachineView/AppServices (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
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
    private let lockEnabled: () -> Bool

    public init(vault: SecretVault, diagnostics: DiagnosticsSink?, lockEnabled: @escaping () -> Bool) {
        (self.vault, self.diagnostics, self.lockEnabled) = (vault, diagnostics, lockEnabled)
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
        try vault.write(Self.prefix + payload.host, JSONEncoder().encode(session), lockEnabled() ? .locked : .standard)
        return session
    }

    public func get(_ host: String) throws -> StoredSession? {
        try vault.read(Self.prefix + host).flatMap { try? JSONDecoder().decode(StoredSession.self, from: $0) }
    }

    public func status(_ host: String, now: Int64) -> (signedIn: Bool, expiresAt: Int64?) {
        guard let s = try? get(host) else { return (false, nil) }
        return (s.exp > now, s.exp)
    }

    public func hosts(orgId: String) throws -> [String] {
        try vault.list(prefix: Self.prefix).compactMap { ns in
            let host = String(ns.dropFirst(Self.prefix.count))
            return (try? get(host))?.orgId == orgId ? host : nil
        }
    }

    public func delete(hosts: [String]) throws {
        for host in hosts { try vault.delete(Self.prefix + host) }
    }

    /// Sign-out, `device_revoked` and org removal: sessions of `orgId` plus `extraHosts`,
    /// their WebView data, the `install_id` and the device key.
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
