/// Connects `RenewalPolicy` to the machine window: open, resume, visibility, timer, reauth.
///
/// Opening or resuming inside the margin renews first; while visible a one-shot timer fires at
/// the policy's next check (the banner 10 minutes out, the overlay at `exp`, even with the
/// socket still open); a reauth signal (`yaranapp://reauth`, an Access redirect, a refusal)
/// shows the overlay. A successful renewal re-injects the cookie and reloads the same URL; a
/// failed one keeps the overlay and hands back the outcome to show. While a renewal's sign-in
/// is out (the user left for Mail or an authenticator), opening or resuming waits for it rather
/// than starting a second one.
///
/// - Absolute `exp` against the wall clock on every event, never a tick count.
/// - Main-thread only, like the views it drives.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/RenewalCoordinator
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// └── MachineViewCore/RenewalPolicy (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RenewalCoordinator
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MainScheduler (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
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
    /// Calls `fire` once at wall-clock `second` (or as soon as possible if that has passed).
    func schedule(at second: Int64, _ fire: @escaping () -> Void) -> Cancellable
}

/// `wait`: a renewal is already out and its success reloads the page.
public enum OpenDecision: Equatable { case load, renewFirst, wait }

public final class RenewalCoordinator {
    private let clock: () -> Int64
    private let scheduler: OneShotScheduler
    private let session: () -> (iat: Int64?, exp: Int64)?
    private weak var renewalUi: RenewalUi?
    private let renew: (@escaping (SignInOutcome) -> Void) -> Void
    private var timer: Cancellable?
    private var visible = false
    private var overlayShown = false
    private var renewal = 0
    private var renewingSince: Int64?
    /// Which route the scheduling belongs to; a callback of an earlier one is inert.
    private var epoch = 0

    public init(clock: @escaping () -> Int64, scheduler: OneShotScheduler, session: @escaping () -> (iat: Int64?, exp: Int64)?,
                ui renewalUi: RenewalUi, renew: @escaping (@escaping (SignInOutcome) -> Void) -> Void) {
        (self.clock, self.scheduler, self.session, self.renewalUi, self.renew) = (clock, scheduler, session, renewalUi, renew)
    }

    public func onOpen() -> OpenDecision { gate(.open) }

    public func onResume() -> OpenDecision { gate(.resume) }

    /// A renewal that has not reported back, for at most the callback TTL (a later reply is refused anyway).
    public var renewing: Bool { renewingSince.map { clock() - $0 <= CallbackUrl.ttlS } ?? false }

    public func onVisibilityChanged(_ visible: Bool) {
        self.visible = visible
        if visible { evaluate() } else { timer?.cancel(); timer = nil }
    }

    /// The window switched routes: the old route's timer goes, a callback it already delivered or a
    /// renewal it started acts on nothing, and its reauth overlay is no longer shown. Only the new
    /// route's own `onOpen`/`evaluate` (an org route) arms anything again.
    public func routeChanged() {
        epoch += 1
        timer?.cancel()
        timer = nil
        overlayShown = false
        renewal += 1
        renewingSince = nil
    }

    /// Re-reads the session and applies the `view` decision; also the timer's callback.
    public func evaluate() {
        timer?.cancel()
        timer = nil
        guard let current = session() else { return showOverlay() }
        let decision = RenewalPolicy.decide(now: clock(), iat: current.iat, exp: current.exp, context: .view, visible: visible)
        switch decision.action {
        case .none, .renewBeforeLoad: renewalUi?.hideBanner()
        case .banner: renewalUi?.showBanner()
        case .overlay: renewalUi?.hideBanner(); showOverlay()
        }
        if let nextCheck = decision.nextCheckAt {
            let mine = epoch
            timer = scheduler.schedule(at: nextCheck) { [weak self] in
                guard let self, self.epoch == mine else { return }
                self.evaluate()
            }
        }
    }

    /// `yaranapp://reauth`, an Access redirect, or a refusal that asks to sign in again.
    public func onReauthSignal() { showOverlay() }

    /// The banner's Renew or the overlay's Sign in (always behind a user gesture), or opening.
    /// A newer renewal replaces an older one; only the newest one's ending clears `renewing`.
    public func renewNow(completion: @escaping (SignInOutcome) -> Void) {
        renewal += 1
        let mine = renewal, route = epoch
        renewingSince = clock()
        renew { [weak self] outcome in
            guard let self else { return }
            if self.renewal == mine { self.renewingSince = nil }
            // A route the window switched away from: its ending reaches nobody, success or failure.
            guard self.epoch == route else { return }
            if case .signedIn = outcome {
                self.overlayShown = false
                self.renewalUi?.hideOverlay()
                self.renewalUi?.hideBanner()
                self.renewalUi?.reloadSameUrl()
                self.evaluate()
            }
            completion(outcome)
        }
    }

    private func gate(_ context: RenewalContext) -> OpenDecision {
        if renewing { return .wait }
        guard let current = session() else { return .renewFirst }
        return RenewalPolicy.decide(now: clock(), iat: current.iat, exp: current.exp, context: context, visible: true).action
            == .renewBeforeLoad ? .renewFirst : .load
    }

    private func showOverlay() {
        guard !overlayShown else { return }
        overlayShown = true
        renewalUi?.showReauthOverlay()
    }
}
