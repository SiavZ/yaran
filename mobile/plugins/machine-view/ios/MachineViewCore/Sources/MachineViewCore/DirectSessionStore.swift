/// Direct machines (G1): the native-only session record and its vault-backed store.
///
/// Split from `Direct.swift`, whose wire rules issue and read these records. The CLI token lives
/// only under the reserved vault namespace `session-direct` (JS `SecureStore` refuses every
/// `session*` namespace); descriptions redact it.
///
/// - Goes through the vault seam (`SecretVault`); nothing else here touches storage.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/DirectSessionStore
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/DirectSessionStore
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/DirectTests (inferred)
/// <module-headers:end>
import Foundation

/// The native-only record of a direct machine's session.
public struct DirectSession: Codable, Equatable, CustomStringConvertible {
    public let host: String
    public let token: String
    public let cookieName: String
    public let instance: String?
    public let issuedAt: Int64
    /// This sign-in's opaque, non-secret name; nil for a record an older build wrote.
    public let signInId: String?

    public init(host: String, token: String, cookieName: String, instance: String?, issuedAt: Int64, signInId: String? = nil) {
        (self.host, self.token, self.cookieName, self.instance, self.issuedAt, self.signInId) = (host, token, cookieName, instance, issuedAt, signInId)
    }

    public var setCookie: String? { DirectWire.setCookie(name: cookieName, token: token) }
    public var description: String { "DirectSession(host: \(host), instance: \(instance ?? "-"), signInId: \(signInId ?? "-"))" }

    /// Only a session bound to a known instance, and to this one, may be sent at all.
    public func bound(to instance: String?) -> Bool { self.instance != nil && self.instance == instance }

    /// May this record be used for a window that `observed` this instance and itself just signed in
    /// as `fresh`? Bound to the observed instance, or, only while no identity is known on either side
    /// (a machine without an instance id), the window's own fresh sign-in. A fresh id never outweighs
    /// a known instance: a mismatch is a mismatch. Instance ids are public: consistency, not auth.
    public func usable(observed: String?, fresh: String?) -> Bool { bound(to: observed) || ownFresh(observed: observed, fresh: fresh) }

    /// The fresh-sign-in bootstrap of `usable`: no instance on either side, and this is that sign-in.
    public func ownFresh(observed: String?, fresh: String?) -> Bool {
        observed == nil && instance == nil && fresh != nil && signInId == fresh
    }

    /// A fresh opaque sign-in id: 128 random bits, base64url.
    public static func newSignInId() -> String { B64url.encode(SymmetricKeyBytes.random(16)) }

    enum CodingKeys: String, CodingKey {
        case host, token, cookieName = "cookie_name", instance, issuedAt = "issued_at", signInId = "sign_in_id"
    }
}

/// A stored record that exists but cannot be used: never "signed out", never silently replaced.
public enum StoredRecordError: Error, Equatable { case unreadable }

public final class DirectSessionStore {
    /// Under the reserved `session` prefix, so JS `SecureStore` can neither read nor write it.
    public static let prefix = "session-direct/"
    private let vault: SecretVault
    private let mutex = NSLock()
    private var changes: [String: Int] = [:]
    public init(vault: SecretVault) { self.vault = vault }

    /// How many times `host`'s record was written or removed through this store: work that read
    /// it before a network await compares it after, so a sign-in or a removal that landed meanwhile
    /// is never overwritten or undone (the app keeps one store, `AppServices.directSessions`).
    public func epoch(_ host: String) -> Int {
        mutex.lock(); defer { mutex.unlock() }
        return changes[host, default: 0]
    }

    private func changed(_ host: String) {
        mutex.lock(); defer { mutex.unlock() }
        changes[host, default: 0] += 1
    }

    public func put(_ session: DirectSession) throws {
        defer { changed(session.host) }
        // Locked class from creation: enabling App Lock later must not leave this bearer readable.
        try vault.write(Self.prefix + session.host, JSONEncoder().encode(session), .locked)
    }

    /// The record, or nil when there is none; throws `VaultError.locked` while locked and
    /// `StoredRecordError.unreadable` for a record that is there but corrupt or for another host.
    public func get(_ host: String) throws -> DirectSession? {
        let data: Data?
        do { data = try vault.read(Self.prefix + host) } catch VaultError.locked { throw VaultError.locked } catch { throw StoredRecordError.unreadable }
        guard let data else { return nil }
        guard let session = try? JSONDecoder().decode(DirectSession.self, from: data), session.host == host, session.setCookie != nil else {
            throw StoredRecordError.unreadable
        }
        return session
    }

    /// The record only when it is bound to `instance` (the one the window just observed) or it is
    /// the sign-in the window itself just made (`fresh`). Anything else, a record from another
    /// instance or an older build's unbound one, is deleted (`dropped` true), so it can never be
    /// attached to the machine now at `host`.
    public func current(_ host: String, instance: String?, fresh: String? = nil) throws -> (session: DirectSession?, dropped: Bool) {
        guard let session = try get(host) else { return (nil, false) }
        if session.usable(observed: instance, fresh: fresh) { return (session, false) }
        try delete(host)
        return (nil, true)
    }

    public func has(_ host: String) -> Bool {
        do { return try vault.read(Self.prefix + host) != nil } catch { return true }
    }

    public func delete(_ host: String) throws {
        defer { changed(host) }
        try vault.delete(Self.prefix + host)
    }
}
