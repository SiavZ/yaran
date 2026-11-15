/// The handoff callback check: right form for this build, exact parameters, pending state.
///
/// Release builds accept only `https://<publisher-domain>/auth/callback`, development builds
/// only `yaranapp://auth/callback`; parameters come from the query or, when it is empty, the
/// fragment (`mode=fragment`, G13). The state must match the in-memory pending entry in
/// constant time and be within its TTL. Pinned by `fixtures/callback-cases.json`.
///
/// - Pure. The order of checks is part of the contract (see the fixture description).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/CallbackUrl
/// ├── MachineViewCore/ControlUrl (inferred)
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/CallbackUrl
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/AuthSessionLauncher (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/HandoffUrl (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// └── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// <module-headers:end>
import Foundation

public enum CallbackMode: Equatable {
    case https(domain: String)
    case dev
}

public struct PendingState: Equatable {
    public let state: String
    public let createdAt: Int64
    public init(state: String, createdAt: Int64) { self.state = state; self.createdAt = createdAt }
}

public enum CallbackRefusal: String, Equatable {
    case wrongForm = "wrong_form"
    case malformed
    case noPending = "no_pending"
    case stateMismatch = "state_mismatch"
    case expired
}

public enum CallbackResult: Equatable {
    case success(jwe: String)
    case error(code: String, min: Int?, max: Int?, serverTime: Int64?)
    case refused(CallbackRefusal)
}

public enum CallbackUrl {
    public static let ttlS: Int64 = 600
    public static let path = "/auth/callback"
    public static let devCommand = "auth/callback"

    /// The decoded parameters when the URI has this build's form, else nil.
    public static func params(mode: CallbackMode, uri: String) -> [String: String]?? {
        guard let split = SplitUri.split(uri) else { return nil }
        switch mode {
        case .https(let domain):
            guard split.scheme == "https", split.authority.lowercased() == domain.lowercased(), split.path == path else { return nil }
        case .dev:
            guard split.scheme == "yaranapp", split.command == devCommand else { return nil }
        }
        guard let query = SplitUri.params(split.query), let fragment = SplitUri.params(split.fragment) else { return .some(nil) }
        return .some(query.isEmpty ? fragment : query)
    }

    public static func parse(mode: CallbackMode, uri: String, pending: PendingState?, now: Int64) -> CallbackResult {
        guard let decoded = params(mode: mode, uri: uri) else { return .refused(.wrongForm) }
        guard let params = decoded, let shaped = shape(params) else { return .refused(.malformed) }
        guard let pending else { return .refused(.noPending) }
        guard constantTimeEqual(Data(params["state", default: ""].utf8), Data(pending.state.utf8)) else {
            return .refused(.stateMismatch)
        }
        guard now - pending.createdAt <= ttlS else { return .refused(.expired) }
        return shaped
    }

    private static func shape(_ params: [String: String]) -> CallbackResult? {
        guard let state = params["state"], Pattern.handoffState.matches(state) else { return nil }
        let keys = Set(params.keys)
        if keys == ["state", "jwe"] {
            let jwe = params["jwe"]!
            return jwe.utf8.count <= 8192 && Pattern.jwe.matches(jwe) ? .success(jwe: jwe) : nil
        }
        guard let code = params["error"], Pattern.errorCode.matches(code),
              keys.isSubset(of: ["state", "error", "min", "max", "server_time"]) else { return nil }
        let rangeAllowed = code == "protocol_unsupported"
        let timeAllowed = code == "handoff_timestamp_skewed"
        var min: Int?, max: Int?, serverTime: Int64?
        for (key, allowed) in [("min", rangeAllowed), ("max", rangeAllowed)] {
            guard let value = params[key] else { continue }
            guard allowed, Pattern.protocolVersion.matches(value) else { return nil }
            if key == "min" { min = Int(value) } else { max = Int(value) }
        }
        if let value = params["server_time"] {
            guard timeAllowed, Pattern.unixSeconds.matches(value) else { return nil }
            serverTime = Int64(value)
        }
        return .error(code: code, min: min, max: max, serverTime: serverTime)
    }
}
