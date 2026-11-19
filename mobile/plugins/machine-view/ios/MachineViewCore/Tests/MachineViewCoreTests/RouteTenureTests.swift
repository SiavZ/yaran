/// RouteTenureTests: work started for one route never acts on another (Sol native review round 6).
///
/// Pure orchestration over `RouteTenure`, `DirectLifecycle.inject` and `RenewalCoordinator` with
/// fake cookie jars and a fake scheduler. The UIKit controller's use of them is pinned by
/// reading its source (`theWindowRoutesItsAsyncWorkThroughTheTenure`); it is not run here.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/RouteTenureTests
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// └── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
private final class Jar: DirectCookieJar {
    var cookies: [HTTPCookie] = []
    var log: [String] = []
    var during: (() -> Void)?
    func allCookies() async -> [HTTPCookie] { during?(); return cookies }
    func deleteCookie(_ cookie: HTTPCookie) async { log.append("delete \(cookie.name)"); during?() }
    func setCookie(_ cookie: HTTPCookie) async { log.append("set \(cookie.name)"); during?() }
}

@MainActor
struct RouteTenureTests {
    @Test func aSwitchEndsTheOldRoutesWorkEvenAfterASwitchBack() {
        let tenure = RouteTenure()
        let onA = tenure.check()
        #expect(onA())
        tenure.switched() // A to B
        #expect(!onA())
        let onB = tenure.check()
        tenure.switched() // B back to A
        #expect(!onA() && !onB())
        #expect(tenure.check()())
        tenure.close()
        #expect(!tenure.check()())
    }

    @Test func keepingTheRouteKeepsItsWork() {
        let tenure = RouteTenure()
        let onA = tenure.check()
        tenure.admit() // a resume probe kept A
        #expect(onA())
        #expect(tenure.takeAdmission())
    }

    @Test func anAdmissionIsSpentByOneLoadAndNeverCrossesASwitch() {
        let tenure = RouteTenure()
        tenure.admit()
        #expect(tenure.takeAdmission())
        #expect(!tenure.takeAdmission(), "a second load probes again")
        tenure.admit()
        tenure.switched()
        #expect(!tenure.takeAdmission(), "A's admission never loads B")
    }

    // A's cookie work is in flight when the window switches to B: it changes nothing more.
    @Test func cookieWorkOfTheOldRouteStopsAtTheSwitch() async {
        let tenure = RouteTenure()
        let jar = Jar()
        jar.cookies = [HTTPCookie(properties: [.name: "old", .value: "v", .domain: "a.example.com", .path: "/"])!]
        jar.during = { tenure.switched() }
        let cookie = HTTPCookie(properties: [.name: "yaran_session_443", .value: "t", .domain: "a.example.com", .path: "/"])
        #expect(await !DirectLifecycle.inject(host: "a.example.com", dropped: true, cookie: cookie, into: jar, owned: tenure.check()))
        #expect(jar.log.isEmpty)
    }

    // Org A's renewal deadline is armed, then the window switches to a direct route B.
    @Test func theOldOrgRoutesRenewalTimerNeverReachesTheNewRoute() throws {
        let rig = RenewalRig()
        rig.coordinator.onVisibilityChanged(true)
        let armed = try #require(rig.scheduler.live)
        rig.coordinator.routeChanged()
        rig.renewalUi.events = [] // what A's open showed; only what follows the switch counts
        rig.signedIn = false // B is direct: no org session behind the coordinator any more
        #expect(rig.scheduler.live == nil, "the old timer is cancelled")
        rig.now = armed.0
        armed.1() // a callback already on its way
        #expect(rig.renewalUi.events.isEmpty)
    }

    // Org A to org B: B arms its own deadline and that one fires as usual.
    @Test func theNewOrgRouteArmsItsOwnTimer() throws {
        let rig = RenewalRig()
        rig.coordinator.onVisibilityChanged(true)
        rig.coordinator.routeChanged()
        rig.exp += 3600 // B's session
        rig.coordinator.evaluate()
        let armed = try #require(rig.scheduler.live)
        #expect(armed.0 == rig.exp - 600)
        rig.now = armed.0
        armed.1()
        #expect(rig.renewalUi.events.last == "banner")
    }

    // A renewal A started ends after the switch, however it ends: no reload, no overlay, and its
    // caller (the window's toast or reauth overlay) hears nothing on B (round 7).
    @Test(arguments: [SignInOutcome.signedIn(host: "a", email: "e", expiresAt: 1), .cancelled, .refused(code: "handoff_declined")])
    func aRenewalOfTheOldRouteDoesNothingOnTheNewOne(_ ending: SignInOutcome) {
        let rig = RenewalRig()
        rig.renewResult = nil
        var heard = 0
        rig.coordinator.renewNow { _ in heard += 1 }
        rig.coordinator.routeChanged()
        rig.renews[0](ending)
        #expect(rig.renewalUi.events.isEmpty)
        #expect(heard == 0)
        #expect(!rig.coordinator.renewing)
    }

    // The current route's renewal still reaches its caller.
    @Test func aRenewalOfTheCurrentRouteIsHeard() {
        let rig = RenewalRig()
        rig.renewResult = nil
        var heard: [SignInOutcome] = []
        rig.coordinator.renewNow { heard.append($0) }
        rig.renews[0](.cancelled)
        #expect(heard == [.cancelled])
    }

    /// The UIKit window wires every asynchronous step through the tenure (type-checked, not run here).
    @Test func theWindowRoutesItsAsyncWorkThroughTheTenure() throws {
        let dir = Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView")
        let direct = try String(contentsOf: dir.appendingPathComponent("MachineViewController+Direct.swift"), encoding: .utf8)
        let main = try String(contentsOf: dir.appendingPathComponent("MachineViewController.swift"), encoding: .utf8)
        let flow = try String(contentsOf: dir.appendingPathComponent("DirectFlow.swift"), encoding: .utf8)
        for wiring in ["tenure.switched()", "coordinator.routeChanged()", "let owned = tenure.check()", "tenure.takeAdmission()",
                       "DirectFlow.signIn(from: self, host: host, owned:"] {
            #expect(direct.contains(wiring), "\(wiring)")
        }
        #expect(main.contains("tenure.close()") && main.contains("tenure.takeAdmission()"))
        #expect(flow.components(separatedBy: "owned()").count - 1 >= 3, "checked before the sheet, at submit and before the POST")
    }
}
