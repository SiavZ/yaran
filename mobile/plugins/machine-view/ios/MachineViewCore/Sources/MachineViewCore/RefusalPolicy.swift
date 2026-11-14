/// What a main-frame response means for the machine window (Phase 02 §13 `Yaran-Refusal`).
///
/// A 401/403 without the header came from Access (reauth); with it, yaran says why: not the
/// owner, keys unavailable, another `access-*` (reauth), a `host-*` (the machine left the
/// cloud), or a code this build does not know (decided by status, with a diagnostics entry).
/// 530 is the tunnel being down. Pinned by `fixtures/refusal-cases.json` and the registry.
///
/// - Pure. `known` lists the registry codes by hand so a new code fails the registry test.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RefusalPolicy
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

public enum RefusalDecision: String, Equatable {
    case none
    case reauth
    case notOwner = "not_owner"
    case keysUnavailable = "keys_unavailable"
    case unavailable
    case hostDisconnected = "host_disconnected"
    case codeOverlay = "code_overlay"
    case offline
}

public struct RefusalVerdict: Equatable {
    public let decision: RefusalDecision
    public let diagnostic: Bool
}

public enum RefusalPolicy {
    public static let header = "Yaran-Refusal"
    public static let known: Set<String> = [
        "access-missing", "access-malformed", "access-bad-algorithm", "access-unknown-kid",
        "access-bad-signature", "access-wrong-issuer", "access-wrong-audience", "access-expired",
        "access-not-yet-valid", "access-not-app-token", "access-service-token", "access-not-owner",
        "access-keys-unavailable", "host-not-served", "host-missing",
    ]

    public static func decide(status: Int, refusal: String?) -> RefusalVerdict {
        if status < 400 { return RefusalVerdict(decision: .none, diagnostic: false) }
        if status == 530 { return RefusalVerdict(decision: .offline, diagnostic: false) }
        guard let code = refusal else {
            return RefusalVerdict(decision: status == 401 || status == 403 ? .reauth : .none, diagnostic: false)
        }
        let decision: RefusalDecision
        if code == "access-not-owner" {
            decision = .notOwner
        } else if code == "access-keys-unavailable" {
            decision = .keysUnavailable
        } else if code.hasPrefix("access-") {
            decision = .reauth
        } else if code.hasPrefix("host-") {
            decision = .hostDisconnected
        } else {
            decision = status == 401 ? .reauth : status == 503 ? .unavailable : .codeOverlay
        }
        return RefusalVerdict(decision: decision, diagnostic: !known.contains(code))
    }
}
