/// When a machine session must be renewed, warned about, or covered (Phase 15 Renewal policy).
///
/// A pure function of the wall-clock `now`, the token's `iat`/`exp`, the context and whether
/// the machine view is visible, pinned by `fixtures/renewal-cases.json` with its Kotlin twin.
/// Opening or resuming renews first inside the margin (a system-browser sheet only ever
/// follows a user's gesture); while viewing, a banner 10 minutes out and an overlay at `exp`.
///
/// - Pure. Times are Unix seconds from the wall clock, never tick counts.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RenewalPolicy
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

public enum RenewalContext: String { case open, resume, view }

public enum RenewalAction: String { case none, renewBeforeLoad = "renew_before_load", banner, overlay }

public struct RenewalDecision: Equatable {
    public let action: RenewalAction
    /// When the decision may next change (Unix seconds), or nil when nothing is pending.
    public let nextCheckAt: Int64?
}

public enum RenewalPolicy {
    public static let preOpenMaxS: Int64 = 7200
    public static let preOpenDivisor: Int64 = 4
    public static let bannerS: Int64 = 600

    public static func margin(iat: Int64?, exp: Int64) -> Int64 {
        guard let iat, exp > iat else { return preOpenMaxS }
        return min(preOpenMaxS, (exp - iat) / preOpenDivisor)
    }

    public static func decide(now: Int64, iat: Int64?, exp: Int64, context: RenewalContext,
                              visible: Bool) -> RenewalDecision {
        switch context {
        case .open, .resume:
            if exp - now < margin(iat: iat, exp: exp) { return RenewalDecision(action: .renewBeforeLoad, nextCheckAt: nil) }
            return RenewalDecision(action: .none, nextCheckAt: exp - bannerS)
        case .view:
            guard visible else { return RenewalDecision(action: .none, nextCheckAt: nil) }
            if now >= exp { return RenewalDecision(action: .overlay, nextCheckAt: nil) }
            if exp - now <= bannerS { return RenewalDecision(action: .banner, nextCheckAt: exp) }
            return RenewalDecision(action: .none, nextCheckAt: exp - bannerS)
        }
    }
}
