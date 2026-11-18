/// Work item 9 tests: renewal wiring with an injected clock and one-shot scheduler.
///
/// Pre-open renewal, the banner at `exp - 10 min`, the overlay at `exp` while the socket is
/// still open, a reauth from the control URL (Phase 13's path after a 4401), and renewals
/// that succeed (re-inject and reload the same URL) or fail (overlay stays, outcome returned);
/// an outstanding renewal makes open and resume wait until it ends or outlives the TTL.
///
/// - Pure; the timer is a fake that the test fires.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/RenewalCoordinatorTests
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/Fakes (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/RenewalCoordinatorTests
/// └── MachineViewCoreTests/RouteTenureTests (inferred)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

final class RenewalRig {
    var now: Int64 = 1_000_000
    var exp: Int64 = 1_000_000 + 86_400
    var signedIn = true
    /// nil: the sign-in is still out until the test calls `renews`.
    var renewResult: SignInOutcome? = .cancelled
    var renews: [(SignInOutcome) -> Void] = []
    let renewalUi = FakeUi(), scheduler = FakeScheduler()
    lazy var coordinator = RenewalCoordinator(
        clock: { [unowned self] in self.now }, scheduler: scheduler,
        session: { [unowned self] in self.signedIn ? (iat: self.exp - 86_400, exp: self.exp) : nil }, ui: renewalUi,
        renew: { [unowned self] done in
            self.renews.append(done)
            if let outcome = self.renewResult { done(outcome) }
        })
}

@Suite struct RenewalCoordinatorTests {
    @Test func openRenewsFirstInsideTheMargin() {
        let rig = RenewalRig()
        #expect(rig.coordinator.onOpen() == .load)
        rig.now = rig.exp - 3600
        #expect(rig.coordinator.onOpen() == .renewFirst)
        #expect(rig.coordinator.onResume() == .renewFirst)
        rig.signedIn = false
        #expect(rig.coordinator.onOpen() == .renewFirst)
    }

    @Test func bannerThenOverlayWithTheSocketStillOpen() throws {
        let rig = RenewalRig()
        rig.coordinator.onVisibilityChanged(true)
        let first = try #require(rig.scheduler.live)
        #expect(first.0 == rig.exp - 600)
        rig.now = first.0
        first.1()
        #expect(rig.renewalUi.events.last == "banner")
        let second = try #require(rig.scheduler.live)
        #expect(second.0 == rig.exp)
        rig.now = second.0
        second.1()
        #expect(rig.renewalUi.events.suffix(2) == ["hideBanner", "overlay"])
        #expect(rig.scheduler.live == nil)
    }

    @Test func hiddenViewCancelsTheTimerAndResumeReevaluates() {
        let rig = RenewalRig()
        rig.coordinator.onVisibilityChanged(true)
        rig.coordinator.onVisibilityChanged(false)
        #expect(rig.scheduler.live == nil)
        rig.now = rig.exp + 10
        rig.coordinator.onVisibilityChanged(true)
        #expect(rig.renewalUi.events.last == "overlay")
    }

    @Test func reauthSignalShowsTheOverlayOnce() {
        let rig = RenewalRig()
        rig.coordinator.onReauthSignal()
        rig.coordinator.onReauthSignal()
        #expect(rig.renewalUi.events.filter { $0 == "overlay" }.count == 1)
    }

    @Test func successfulRenewalReloadsTheSameUrl() {
        let rig = RenewalRig()
        rig.coordinator.onVisibilityChanged(true)
        rig.coordinator.onReauthSignal()
        rig.renewResult = .signedIn(host: "h", email: "e", expiresAt: rig.exp)
        var got: SignInOutcome?
        rig.coordinator.renewNow { got = $0 }
        #expect(got?.kind == "signed_in")
        #expect(rig.renewalUi.events.contains("hideOverlay") && rig.renewalUi.events.contains("reload"))
        rig.coordinator.onReauthSignal()
        #expect(rig.renewalUi.events.filter { $0 == "overlay" }.count == 2)
    }

    @Test func anOutstandingRenewalWaitsUntilItEndsOrOutlivesTheTtl() {
        let rig = RenewalRig()
        rig.now = rig.exp + 10
        rig.renewResult = nil
        rig.coordinator.renewNow { _ in }
        #expect(rig.coordinator.onResume() == .wait && rig.coordinator.onOpen() == .wait)
        rig.renews[0](.cancelled)
        #expect(rig.coordinator.onResume() == .renewFirst, "a cancelled sign-in does not keep the wait")
        rig.coordinator.renewNow { _ in }
        rig.now += CallbackUrl.ttlS + 1
        #expect(rig.coordinator.onResume() == .renewFirst, "one that never reports back stops the wait at the TTL")
    }

    @Test func onlyTheNewestRenewalsEndingClearsTheWait() {
        let rig = RenewalRig()
        rig.renewResult = nil
        var got: [SignInOutcome] = []
        rig.coordinator.renewNow { got.append($0) }
        rig.coordinator.renewNow { got.append($0) }
        rig.renews[0](.cancelled) // the replaced sign-in, as HandoffClient ends it
        #expect(rig.coordinator.renewing)
        rig.renews[1](.signedIn(host: "h", email: "e", expiresAt: rig.exp))
        #expect(!rig.coordinator.renewing && got.map(\.kind) == ["cancelled", "signed_in"])
        #expect(rig.renewalUi.events.filter { $0 == "reload" }.count == 1)
    }

    @Test func failedRenewalKeepsTheOverlayAndStatesTheOutcome() {
        let rig = RenewalRig()
        rig.coordinator.onReauthSignal()
        rig.renewResult = .declined
        var got: SignInOutcome?
        rig.coordinator.renewNow { got = $0 }
        #expect(got == .declined)
        #expect(!rig.renewalUi.events.contains("hideOverlay") && !rig.renewalUi.events.contains("reload"))
    }
}
