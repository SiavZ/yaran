/// Connects `RenewalPolicy` to the machine window: open, resume, visibility, timer, reauth.
///
/// Opening or resuming inside the margin renews first; while visible a one-shot timer fires at
/// the policy's next check (the banner 10 minutes out, the overlay at `exp`, even with the
/// socket still open); a reauth signal (`yaranapp://reauth`, an Access redirect, a refusal)
/// shows the overlay. A successful renewal re-injects the cookie and reloads the same URL; a
/// failed one keeps the overlay and hands back the outcome to show.
///
/// - Absolute `exp` against the wall clock on every event, never a tick count.
/// - Main-thread only, like the views it drives.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/RenewalCoordinator
/// ├── MachineViewCore/Outcomes (inferred)
/// └── MachineViewCore/RenewalPolicy (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RenewalCoordinator
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// <module-headers:end>
import Foundation

public protocol RenewalUi: AnyObject {
    func showBanner()
    func hideBanner()
    func showReauthOverlay()
    func hideOverlay()
    /// Re-inject the cookie, then reload the URL the page is on.
    func reloadSameUrl()
}

public protocol Cancellable { func cancel() }

public protocol OneShotScheduler: AnyObject {
    /// Calls `fire` once at wall-clock second `at` (or as soon as possible if that has passed).
    func schedule(at: Int64, _ fire: @escaping () -> Void) -> Cancellable
}

public enum OpenDecision: Equatable { case load, renewFirst }

public final class RenewalCoordinator {
    private let clock: () -> Int64
    private let scheduler: OneShotScheduler
    private let session: () -> (iat: Int64?, exp: Int64)?
    private weak var ui: RenewalUi?
    private let renew: (@escaping (SignInOutcome) -> Void) -> Void
    private var timer: Cancellable?
    private var visible = false
    private var overlayShown = false

    public init(clock: @escaping () -> Int64, scheduler: OneShotScheduler, session: @escaping () -> (iat: Int64?, exp: Int64)?,
                ui: RenewalUi, renew: @escaping (@escaping (SignInOutcome) -> Void) -> Void) {
        (self.clock, self.scheduler, self.session, self.ui, self.renew) = (clock, scheduler, session, ui, renew)
    }

    public func onOpen() -> OpenDecision { gate(.open) }

    public func onResume() -> OpenDecision { gate(.resume) }

    public func onVisibilityChanged(_ visible: Bool) {
        self.visible = visible
        if visible { evaluate() } else { timer?.cancel(); timer = nil }
    }

    /// Re-reads the session and applies the `view` decision; also the timer's callback.
    public func evaluate() {
        timer?.cancel()
        timer = nil
        guard let s = session() else { return showOverlay() }
        let d = RenewalPolicy.decide(now: clock(), iat: s.iat, exp: s.exp, context: .view, visible: visible)
        switch d.action {
        case .none, .renewBeforeLoad: ui?.hideBanner()
        case .banner: ui?.showBanner()
        case .overlay: ui?.hideBanner(); showOverlay()
        }
        if let at = d.nextCheckAt { timer = scheduler.schedule(at: at) { [weak self] in self?.evaluate() } }
    }

    /// `yaranapp://reauth`, an Access redirect, or a refusal that asks to sign in again.
    public func onReauthSignal() { showOverlay() }

    /// The banner's Renew or the overlay's Sign in (always behind a user gesture).
    public func renewNow(completion: @escaping (SignInOutcome) -> Void) {
        renew { [weak self] outcome in
            guard let self else { return }
            if case .signedIn = outcome {
                self.overlayShown = false
                self.ui?.hideOverlay()
                self.ui?.hideBanner()
                self.ui?.reloadSameUrl()
                self.evaluate()
            }
            completion(outcome)
        }
    }

    private func gate(_ context: RenewalContext) -> OpenDecision {
        guard let s = session() else { return .renewFirst }
        return RenewalPolicy.decide(now: clock(), iat: s.iat, exp: s.exp, context: context, visible: true).action
            == .renewBeforeLoad ? .renewFirst : .load
    }

    private func showOverlay() {
        guard !overlayShown else { return }
        overlayShown = true
        ui?.showReauthOverlay()
    }
}
