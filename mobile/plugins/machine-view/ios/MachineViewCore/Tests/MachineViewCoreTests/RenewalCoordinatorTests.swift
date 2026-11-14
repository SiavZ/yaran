/// Work item 9 tests: renewal wiring with an injected clock and one-shot scheduler.
///
/// Pre-open renewal, the banner at `exp - 10 min`, the overlay at `exp` while the socket is
/// still open, a reauth from the control URL (Phase 13's path after a 4401), and renewals
/// that succeed (re-inject and reload the same URL) or fail (overlay stays, outcome returned).
///
/// - Pure; the timer is a fake that the test fires.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/RenewalCoordinatorTests
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// └── MachineViewCoreTests/Fakes (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

final class RenewalRig {
    var now: Int64 = 1_000_000
    var exp: Int64 = 1_000_000 + 86_400
    var signedIn = true
    var renewResult: SignInOutcome = .cancelled
    let ui = FakeUi(), scheduler = FakeScheduler()
    lazy var coordinator = RenewalCoordinator(
        clock: { [unowned self] in self.now }, scheduler: scheduler,
        session: { [unowned self] in self.signedIn ? (iat: self.exp - 86_400, exp: self.exp) : nil }, ui: ui,
        renew: { [unowned self] done in done(self.renewResult) })
}

@Suite struct RenewalCoordinatorTests {
    @Test func openRenewsFirstInsideTheMargin() {
        let r = RenewalRig()
        #expect(r.coordinator.onOpen() == .load)
        r.now = r.exp - 3600
        #expect(r.coordinator.onOpen() == .renewFirst)
        #expect(r.coordinator.onResume() == .renewFirst)
        r.signedIn = false
        #expect(r.coordinator.onOpen() == .renewFirst)
    }

    @Test func bannerThenOverlayWithTheSocketStillOpen() throws {
        let r = RenewalRig()
        r.coordinator.onVisibilityChanged(true)
        let first = try #require(r.scheduler.live)
        #expect(first.0 == r.exp - 600)
        r.now = first.0
        first.1()
        #expect(r.ui.events.last == "banner")
        let second = try #require(r.scheduler.live)
        #expect(second.0 == r.exp)
        r.now = second.0
        second.1()
        #expect(r.ui.events.suffix(2) == ["hideBanner", "overlay"])
        #expect(r.scheduler.live == nil)
    }

    @Test func hiddenViewCancelsTheTimerAndResumeReevaluates() {
        let r = RenewalRig()
        r.coordinator.onVisibilityChanged(true)
        r.coordinator.onVisibilityChanged(false)
        #expect(r.scheduler.live == nil)
        r.now = r.exp + 10
        r.coordinator.onVisibilityChanged(true)
        #expect(r.ui.events.last == "overlay")
    }

    @Test func reauthSignalShowsTheOverlayOnce() {
        let r = RenewalRig()
        r.coordinator.onReauthSignal()
        r.coordinator.onReauthSignal()
        #expect(r.ui.events.filter { $0 == "overlay" }.count == 1)
    }

    @Test func successfulRenewalReloadsTheSameUrl() {
        let r = RenewalRig()
        r.coordinator.onVisibilityChanged(true)
        r.coordinator.onReauthSignal()
        r.renewResult = .signedIn(host: "h", email: "e", expiresAt: r.exp)
        var got: SignInOutcome?
        r.coordinator.renewNow { got = $0 }
        #expect(got?.kind == "signed_in")
        #expect(r.ui.events.contains("hideOverlay") && r.ui.events.contains("reload"))
        r.coordinator.onReauthSignal()
        #expect(r.ui.events.filter { $0 == "overlay" }.count == 2)
    }

    @Test func failedRenewalKeepsTheOverlayAndStatesTheOutcome() {
        let r = RenewalRig()
        r.coordinator.onReauthSignal()
        r.renewResult = .declined
        var got: SignInOutcome?
        r.coordinator.renewNow { got = $0 }
        #expect(got == .declined)
        #expect(!r.ui.events.contains("hideOverlay") && !r.ui.events.contains("reload"))
    }
}
