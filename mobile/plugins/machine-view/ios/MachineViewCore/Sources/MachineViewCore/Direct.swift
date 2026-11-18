/// Direct machines (G1): the wire rules, outcomes and the native-only session record.
///
/// The Swift twin of `Direct.kt`, pinned to the same `fixtures/direct-cases.json`. A direct
/// machine is a yaran reached over HTTPS on the default port without Cloud Connect; its
/// password goes from a native sheet to the existing `cli-login`, and the CLI token that comes
/// back lives only under the reserved vault namespace `session-direct` (JS `SecureStore`
/// refuses every `session*` namespace) and reaches the page only as the host-only
/// `yaran_session_<port>` cookie. Wire: docs/operations/mobile-parity-contracts.md.
///
/// - Pure apart from `DirectSessionStore`, which goes through the vault seam.
/// - No outcome carries the password, the token or the cookie name; descriptions redact.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/Direct
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// └── MachineViewCore/UrlParts (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/Direct
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineView/MachineViewPlugin (inferred)
/// ├── MachineView/SessionPlugin (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/DirectTests (inferred)
/// <module-headers:end>
import Foundation

public enum DirectStatus: Equatable {
    case yaran(instance: String?, passwordSet: Bool, requiredHere: Bool, signedIn: Bool, transportEncrypted: Bool)
    case notYaran, accessRequired, redirected, offline, tlsError, vaultLocked
    /// A yaran whose status lacks `native_auth_ui: true`: its page could ask for the password in the window.
    case upgradeRequired
    case refused(reason: String)

    public var kind: String {
        switch self {
        case .yaran: return "yaran"
        case .upgradeRequired: return "upgrade_required"
        case .notYaran: return "not_yaran"
        case .accessRequired: return "access_required"
        case .redirected: return "redirected"
        case .offline: return "offline"
        case .tlsError: return "tls_error"
        case .vaultLocked: return "vault_locked"
        case .refused: return "refused"
        }
    }

    public var jsObject: [String: Any] {
        switch self {
        case let .yaran(instance, passwordSet, requiredHere, signedIn, transportEncrypted):
            return ["kind": kind, "instance": instance ?? NSNull(), "passwordSet": passwordSet, "requiredHere": requiredHere,
                    "signedIn": signedIn, "transportEncrypted": transportEncrypted]
        case .refused(let reason): return ["kind": kind, "reason": reason]
        case .notYaran, .accessRequired, .redirected, .offline, .tlsError, .vaultLocked, .upgradeRequired: return ["kind": kind]
        }
    }

    /// The same failure as a sign-in outcome (the kinds are shared).
    public var asSignIn: DirectSignInOutcome {
        switch self {
        case .yaran: return .refused(reason: "not_json") // never asked of a yaran answer
        case .notYaran: return .notYaran
        case .accessRequired: return .accessRequired
        case .redirected: return .redirected
        case .offline: return .offline
        case .tlsError: return .tlsError
        case .vaultLocked: return .vaultLocked
        case .upgradeRequired: return .upgradeRequired
        case .refused(let reason): return .refused(reason: reason)
        }
    }
}

public enum DirectSignInOutcome: Equatable {
    /// `signInId` is this sign-in's opaque, non-secret name (never derived from the token).
    case signedIn(host: String, instance: String?, signInId: String)
    case notRequired, cancelled
    case wrongPassword(message: String)
    case rateLimited(retryAfterSeconds: Int64, message: String)
    case noPassword(message: String)
    case serverRefused(status: Int, code: String, message: String)
    case notYaran, accessRequired, redirected, offline, tlsError, vaultLocked, upgradeRequired
    case refused(reason: String)
    /// The vault could not keep the session while unlocked; the machine's token was revoked.
    case secureStorageFailed

    public var kind: String {
        switch self {
        case .signedIn: return "signed_in"
        case .notRequired: return "not_required"
        case .cancelled: return "cancelled"
        case .wrongPassword: return "wrong_password"
        case .rateLimited: return "rate_limited"
        case .noPassword: return "no_password"
        case .serverRefused: return "server_refused"
        case .notYaran: return "not_yaran"
        case .accessRequired: return "access_required"
        case .redirected: return "redirected"
        case .offline: return "offline"
        case .tlsError: return "tls_error"
        case .vaultLocked: return "vault_locked"
        case .upgradeRequired: return "upgrade_required"
        case .refused: return "refused"
        case .secureStorageFailed: return "secure_storage_failed"
        }
    }

    public var jsObject: [String: Any] {
        var out: [String: Any] = ["kind": kind]
        switch self {
        case let .signedIn(host, instance, signInId): out["host"] = host; out["instance"] = instance ?? NSNull(); out["signInId"] = signInId
        case .wrongPassword(let message), .noPassword(let message): out["message"] = message
        case let .rateLimited(seconds, message): out["retryAfterSeconds"] = seconds; out["message"] = message
        case let .serverRefused(status, code, message): out["status"] = status; out["code"] = code; out["message"] = message
        case .refused(let reason): out["reason"] = reason
        case .notRequired, .cancelled, .notYaran, .accessRequired, .redirected, .offline, .tlsError, .vaultLocked, .upgradeRequired,
             .secureStorageFailed: break
        }
        return out
    }

    /// The machine's own sentence, when the outcome carries one.
    public var serverMessage: String? {
        switch self {
        case .wrongPassword(let message), .noPassword(let message), .rateLimited(_, let message), .serverRefused(_, _, let message):
            return message.isEmpty ? nil : message
        default: return nil
        }
    }
}

public enum DirectSignOutOutcome: Equatable {
    case signedOut(serverEnded: Bool)
    case vaultLocked, secureStorageFailed, refused
    /// The sign-in named is no longer the host's current one: nothing was ended or cleared.
    case notCurrent

    public var jsObject: [String: Any] {
        switch self {
        case .signedOut(let ended): return ["kind": "signed_out", "serverEnded": ended]
        case .notCurrent: return ["kind": "not_current"]
        case .vaultLocked: return ["kind": "vault_locked"]
        case .secureStorageFailed: return ["kind": "secure_storage_failed"]
        case .refused: return ["kind": "refused", "reason": "invalid_host"]
        }
    }
}

/// What a `cli-login` answer means: a session to keep, or an outcome (and a stray token to revoke).
public enum LoginAnswer: Equatable, CustomStringConvertible {
    case token(String, cookieName: String)
    case failed(DirectSignInOutcome, revoke: String?)

    public var description: String {
        switch self {
        case .token: return "token(<redacted>)"
        case .failed(let outcome, _): return "failed(\(outcome.kind))"
        }
    }
}

public enum DirectWire {
    public static let statusPath = "/api/v1/auth/status"
    public static let loginPath = "/api/v1/auth/cli-login"
    public static let logoutPath = "/api/v1/auth/cli-logout"
    public static let maxMessage = 300
    static let cookieName = Pattern("yaran_session_[0-9]{1,5}")
    static let token = Pattern("[A-Za-z0-9_-]{1,256}")
    static let code = Pattern("[a-z][a-z0-9_]{0,63}")
    static let instance = Pattern("[\\x21-\\x7e]{1,128}")
    private static let accessSuffix = ".cloudflareaccess.com"
    private static let accessLogin = "/cdn-cgi/access/login"
    private static let attrs = "Path=/; Secure; HttpOnly; SameSite=Strict"

    /// The contract's `isPublicHost`: a lowercase DNS name of two or more labels, alphabetic TLD, no `xn--` label.
    public static func isPublicHost(_ host: String) -> Bool {
        host.count <= 253 && Pattern.orgUrl.matches("https://\(host)") && !host.split(separator: ".").contains { $0.hasPrefix("xn--") }
    }

    public static func setCookie(name: String, token value: String) -> String? {
        cookieName.matches(name) && token.matches(value) ? "\(name)=\(value); \(attrs)" : nil
    }

    /// A machine's own sentence made safe to show as text: no control or format characters, at most 300 code points.
    public static func cleanMessage(_ raw: Any?) -> String {
        guard let text = raw as? String else { return "" }
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars where out.count < maxMessage {
            switch scalar.properties.generalCategory {
            case .control, .format: continue
            default: out.append(scalar)
            }
        }
        return String(out).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isAccessRedirect(_ location: String?) -> Bool {
        guard let location else { return false }
        if location.hasPrefix(accessLogin) { return true }
        guard let parts = UrlParts.parse(location), let host = parts.hostAndPort?.host else { return false }
        return (host.hasSuffix(accessSuffix) && host.count > accessSuffix.count) || parts.path.hasPrefix(accessLogin)
    }

    private static func json(_ body: Data) -> Any? { try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) }

    private static func isJson(_ contentType: String?) -> Bool { contentType?.lowercased().contains("json") == true }

    public static func classifyStatus(status: Int, location: String?, contentType: String?, body: Data) -> DirectStatus {
        if (300...399).contains(status) { return isAccessRedirect(location) ? .accessRequired : .redirected }
        guard status == 200, isJson(contentType) else { return .notYaran }
        guard let value = json(body) else { return .refused(reason: "not_json") }
        guard let obj = value as? [String: Any] else { return .notYaran }
        let flags = ["password_set", "required_here", "signed_in", "transport_encrypted"].map { boolean(obj[$0]) }
        guard flags.allSatisfy({ $0 != nil }) else { return .notYaran }
        var inst: String?
        switch obj["instance"] {
        case nil, is NSNull: inst = nil
        case let text as String where instance.matches(text): inst = text
        default: return .notYaran
        }
        // Compatibility only: a build whose page could take the password in the window is never admitted.
        guard boolean(obj["native_auth_ui"]) == true else { return .upgradeRequired }
        return .yaran(instance: inst, passwordSet: flags[0]!, requiredHere: flags[1]!, signedIn: flags[2]!, transportEncrypted: flags[3]!)
    }

    public static func classifyLogin(status: Int, location: String?, contentType: String?, body: Data) -> LoginAnswer {
        if (300...399).contains(status) { return .failed(isAccessRedirect(location) ? .accessRequired : .redirected, revoke: nil) }
        let obj = isJson(contentType) ? json(body) as? [String: Any] : nil
        if status == 200 {
            guard let obj else { return .failed(.refused(reason: "not_json"), revoke: nil) }
            guard let value = obj["token"] as? String, token.matches(value) else {
                return .failed(.serverRefused(status: 200, code: "token_invalid", message: ""), revoke: nil)
            }
            guard let name = obj["cookie_name"] as? String else {
                return .failed(.serverRefused(status: 200, code: "cookie_name_missing", message: ""), revoke: value)
            }
            guard cookieName.matches(name) else { return .failed(.serverRefused(status: 200, code: "cookie_name_invalid", message: ""), revoke: value) }
            return .token(value, cookieName: name)
        }
        let errorCode = (obj?["error"] as? String).flatMap { code.matches($0) ? $0 : nil } ?? "unknown"
        let message = cleanMessage(obj?["message"])
        let outcome: DirectSignInOutcome
        if status == 401 && errorCode == "wrong_password" {
            outcome = .wrongPassword(message: message)
        } else if status == 429 {
            outcome = .rateLimited(retryAfterSeconds: max(0, SealedEnvelope.integer(obj?["retry_after_seconds"]) ?? 0), message: message)
        } else if status == 409 && errorCode == "no_password" {
            outcome = .noPassword(message: message)
        } else {
            outcome = .serverRefused(status: status, code: errorCode, message: message)
        }
        return .failed(outcome, revoke: nil)
    }

    /// `{"password":…,"label":…}` as UTF-8; the caller zeroes the returned bytes after the POST.
    public static func loginBody(password: inout [UInt8], label: String) -> Data {
        var out = Data("{\"password\":\"".utf8)
        for byte in password {
            switch byte {
            case UInt8(ascii: "\""): out.append(contentsOf: Array("\\\"".utf8))
            case UInt8(ascii: "\\"): out.append(contentsOf: Array("\\\\".utf8))
            case 0..<0x20: out.append(contentsOf: Array(String(format: "\\u%04x", byte).utf8))
            default: out.append(byte)
            }
        }
        for index in password.indices { password[index] = 0 }
        let quoted = (try? JSONSerialization.data(withJSONObject: [label], options: [.fragmentsAllowed])).flatMap {
            String(data: $0, encoding: .utf8).map { String($0.dropFirst().dropLast()) }
        } ?? "\"\""
        out.append(contentsOf: Array("\",\"label\":\(quoted)}".utf8))
        return out
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
}

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

/// One route: an org machine signs in through Access, a direct one through its own password.
public enum MachineRoute: Equatable {
    case org(orgId: String, machineId: String, host: String)
    case direct(host: String)

    public var host: String {
        switch self {
        case .org(_, _, let host), .direct(let host): return host
        }
    }

    private static let machineId = Pattern("[A-Za-z0-9._:-]{1,128}")

    /// `{kind, host[, orgId, machineId]}` from JS, validated as the Kotlin twin does.
    public init?(_ object: [String: Any]) {
        switch object["kind"] as? String {
        case "org":
            guard let orgId = object["orgId"] as? String, orgId.count <= 261, Pattern.orgUrl.matches(orgId),
                  let machine = object["machineId"] as? String, Self.machineId.matches(machine),
                  let host = object["host"] as? String, Pattern.hostname.matches(host) else { return nil }
            self = .org(orgId: orgId, machineId: machine, host: host)
        case "direct":
            guard let host = object["host"] as? String, DirectWire.isPublicHost(host) else { return nil }
            self = .direct(host: host)
        default:
            return nil
        }
    }
}

public enum Probe: String, Equatable { case match, matchSignIn = "match_sign_in", mismatch, unreachable, signInFirst = "sign_in_first" }

public enum Selection: Equatable {
    case chosen(Int), kept(Int), signInFirst(Int), noRoute
}

/// Which of a machine's user-approved routes to load (G2); the twin of `RouteSelector.kt`.
public enum RouteSelector {
    /// `current` is nil at open; at a revisit (resume, retry) it is probed first and kept when it answers.
    public static func select(count: Int, current: Int?, probe: (Int) -> Probe) -> Selection {
        let order = current.map { cur in [cur] + (0..<count).filter { $0 != cur } } ?? Array(0..<count)
        var signInFirst: Int?
        for index in order {
            switch probe(index) {
            case .match, .matchSignIn: return index == current ? .kept(index) : .chosen(index)
            case .signInFirst: if signInFirst == nil { signInFirst = index }
            case .mismatch, .unreachable: continue
            }
        }
        return signInFirst.map { .signInFirst($0) } ?? .noRoute
    }

    /// A status answer against the recorded instance (nil: nothing recorded, any yaran matches).
    public static func probe(of status: DirectStatus, instance: String?) -> Probe {
        guard case let .yaran(answered, _, requiredHere, signedIn, _) = status else { return .unreachable }
        if let instance, answered != instance { return .mismatch }
        return requiredHere && !signedIn ? .matchSignIn : .match
    }
}

/// The `closed` event's payload: the reason, its code, the host the window was on (the one
/// rejected, for `instance_changed`; none for `no_route`) and the host its open named, so the
/// shell attributes a late close to the right machine. Host names only.
public enum ClosedPayload {
    public static func make(reason: String, code: String?, routes: [String], chosen: Int) -> [String: Any] {
        var out: [String: Any] = ["reason": reason]
        if let code { out["code"] = code }
        if code != "no_route", routes.indices.contains(chosen) { out["host"] = routes[chosen] }
        if let first = routes.first { out["requestedHost"] = first }
        return out
    }
}

/// Whether the machine page owes a reload: a WebContent crash reloads at once, or, behind the
/// lock, is owed until a navigation is actually submitted. A resume or route choice that loads
/// nothing (all routes offline, a sign-in cancelled) leaves it owed; any other resume only
/// re-injects the credential, so a healthy page is never reloaded.
public struct PageReload: Equatable {
    public private(set) var owed = false

    public init() {}

    /// True when the page should reload now. Every termination owes a reload until a navigation is
    /// really submitted (`loaded`): one that is tried now and fails (offline, refused) is still owed.
    public mutating func contentTerminated(locked: Bool) -> Bool {
        owed = true
        return !locked
    }

    /// A navigation was submitted: what was owed is settled.
    public mutating func loaded() { owed = false }
}
