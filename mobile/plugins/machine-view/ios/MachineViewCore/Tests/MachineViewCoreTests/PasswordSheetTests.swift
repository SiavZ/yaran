/// PasswordSheetTests: a route's password sheet goes with its route (Sol native review round 11).
///
/// The window's sign-in sheet answers through `PendingSheet`, held in the window's `OpenPrompts`
/// with its file chooser; a route switch or close settles both. Here route A's sheet is up when a
/// resume moves the window to B: A's sheet is dismissed and answered with nothing once, nothing is
/// posted for A, a late tap on it does nothing, and B's own sheet is not touched. The UIKit alert and
/// `DirectFlow` are type-checked and pinned by reading their source, not run here.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/PasswordSheetTests
/// ├── MachineViewCore/PendingChooser (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
struct PasswordSheetTests {
    /// What `DirectFlow.signIn` does with an answer: posts only while the route still owns the sheet.
    @MainActor
    private final class Flow {
        var dismissed: [String] = []
        var cancelled = 0
        var posted: [String] = []

        func sheet(_ route: String, owned: @escaping () -> Bool) -> PendingSheet {
            PendingSheet(dismiss: { [unowned self] in self.dismissed.append(route) }, answer: { [unowned self] password in
                guard let password, owned() else { return self.cancelled += 1 }
                self.posted.append("\(route):\(String(bytes: password, encoding: .utf8) ?? "")")
            })
        }
    }

    @Test func aRouteSwitchSettlesTheOldRoutesSheetOnce() {
        let tenure = RouteTenure()
        let prompts = OpenPrompts()
        let flow = Flow()
        let sheetA = flow.sheet("A", owned: tenure.check())
        prompts.sheet = sheetA
        tenure.switched() // a long-away resume chose route B
        prompts.settleAll()
        #expect(flow.dismissed == ["A"] && flow.cancelled == 1 && flow.posted.isEmpty)
        sheetA.respond(Array("hunter2".utf8)) // a tap that was already on its way
        sheetA.cancel()
        #expect(flow.cancelled == 1 && flow.posted.isEmpty && flow.dismissed == ["A"], "once")

        let sheetB = flow.sheet("B", owned: tenure.check())
        prompts.sheet = sheetB
        #expect(flow.dismissed == ["A"], "B's sheet is not touched")
        sheetB.respond(Array("pw".utf8))
        #expect(flow.posted == ["B:pw"], "the current route's sheet works as before")
    }

    @Test func theUsersOwnCancelAnswersOnceAndDismissesNothingMore() {
        let tenure = RouteTenure()
        let flow = Flow()
        let sheet = flow.sheet("A", owned: tenure.check())
        sheet.respond(nil)
        sheet.cancel()
        #expect(flow.cancelled == 1 && flow.dismissed.isEmpty, "the alert dismissed itself")
    }

    @Test func settlingAlsoTellsWhetherAChooserWasPending() {
        let prompts = OpenPrompts()
        #expect(!prompts.settleAll())
        var answers: [[URL]?] = []
        prompts.chooser = PendingChooser(held: [], owned: { true }, answer: { answers.append($0) })
        #expect(prompts.settleAll() && answers.count == 1 && answers[0] == nil && prompts.chooser == nil)
    }

    /// The window and the flow are wired this way (type-checked, not run here).
    @Test func theWindowHoldsItsSheetAndSettlesItWithTheRoute() throws {
        let dir = Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView")
        let direct = try String(contentsOf: dir.appendingPathComponent("MachineViewController+Direct.swift"), encoding: .utf8)
        let main = try String(contentsOf: dir.appendingPathComponent("MachineViewController.swift"), encoding: .utf8)
        let flow = try String(contentsOf: dir.appendingPathComponent("DirectFlow.swift"), encoding: .utf8)
        #expect(direct.contains("onSheet: { [weak self] in self?.prompts.sheet = $0 }"))
        #expect(direct.contains("tenure.switched()\n        coordinator.routeChanged()\n        settlePrompts()"), "on every route switch")
        #expect(main.contains("tenure.close()\n        settlePrompts()"), "and on close")
        #expect(flow.contains("PendingSheet(dismiss: { [weak alert] in alert?.dismiss(animated: false) }, answer: done)"))
        #expect(flow.contains("pending.respond(nil)") && flow.contains("pending.respond(bytes)") && !flow.contains("{ _ in done(nil) }"))
    }
}
