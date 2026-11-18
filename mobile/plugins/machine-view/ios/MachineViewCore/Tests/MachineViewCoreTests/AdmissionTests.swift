/// AdmissionTests: what may load into a machine window, and who an answer belongs to (Sol native
/// review round 7). Pure orchestration over `RouteTenure`, `DocumentVerdict`, `NavigationDelegate`,
/// `PendingChooser` and `DirectLifecycle.keepIfCurrent` with stubbed machines; the UIKit window's
/// use of them is pinned by reading its source, and is not run here.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/AdmissionTests
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// ├── MachineViewCore/PendingChooser (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
struct AdmissionTests {
    private let page = URL(string: "https://a.example.com/")!

    // Finding 2: a reload that finds another instance chooses again; it never admits with the old context.
    @Test func aDocumentOfAnotherInstanceIsANewSelection() {
        let yaran = { (instance: String?) in DirectStatus.yaran(instance: instance, passwordSet: true, requiredHere: true, signedIn: true,
                                                                transportEncrypted: true) }
        #expect(DocumentVerdict.of(probe: .match, status: yaran("i1"), seen: "i1") == .admit)
        #expect(DocumentVerdict.of(probe: .match, status: yaran("i2"), seen: "i1") == .reselect, "observed i1, answered i2")
        #expect(DocumentVerdict.of(probe: .mismatch, status: yaran("i2"), seen: nil) == .reselect, "the recorded instance differs")
        #expect(DocumentVerdict.of(probe: .match, status: yaran(nil), seen: "i1") == .reselect)
        #expect(DocumentVerdict.of(probe: .match, status: yaran("i1"), seen: nil) == .admit)
        #expect(DocumentVerdict.of(probe: .signInFirst, status: nil, seen: nil) == .signIn)
        #expect(DocumentVerdict.of(probe: .unreachable, status: .upgradeRequired, seen: "i1") == .refuse)
    }

    // Round 9: a form posting the page to another host, another port or plain http is blocked by
    // the navigation policy and is never the route's origin for admission either.
    @Test func onlyTheRoutesOwnOriginIsAdmitted() {
        let host = "a.example.com"
        #expect(DocumentVerdict.isRouteOrigin(URL(string: "https://a.example.com/x")!, host: host))
        #expect(DocumentVerdict.isRouteOrigin(URL(string: "https://A.example.com:443/")!, host: host))
        for other in ["https://evil.example.com/collect", "https://a.example.com:8443/", "http://a.example.com/"] {
            #expect(!DocumentVerdict.isRouteOrigin(URL(string: other)!, host: host), "\(other)")
            let delegate = NavigationDelegate(pinnedHost: host, diagnostics: nil)
            #expect(!delegate.apply(url: URL(string: other), mainFrame: true, newWindow: false, gesture: false) { _ in }, "\(other)")
        }
    }

    // Round 11: a window with no recorded instance signed in at i1 (fresh id), then the document
    // probe found i2 and the selection observed it. The fresh id never outweighs that: the real
    // store drops the i1 record, and the window's own-sign-in shortcut is off.
    @Test func aFreshSignInNeverOutweighsAKnownInstanceMismatch() throws {
        let store = DirectSessionStore(vault: MemoryVault())
        let mine = DirectSession(host: "a.example.com", token: "tokA", cookieName: "yaran_session_443", instance: "i1", issuedAt: 1, signInId: "fresh")
        try store.put(mine)
        #expect(try store.current("a.example.com", instance: "i1", fresh: "fresh").session == mine, "its own instance")
        let now = try store.current("a.example.com", instance: "i2", fresh: "fresh")
        #expect(now.session == nil && now.dropped, "i2 observed: the i1 record goes, fresh id or not")
        #expect(try store.get("a.example.com") == nil)
        #expect(!mine.ownFresh(observed: "i2", fresh: "fresh") && !mine.ownFresh(observed: "i1", fresh: "fresh"))
        // The bootstrap stands only where no identity exists on either side.
        let bare = DirectSession(host: "a.example.com", token: "tokB", cookieName: "yaran_session_443", instance: nil, issuedAt: 1, signInId: "fresh")
        #expect(bare.usable(observed: nil, fresh: "fresh") && bare.ownFresh(observed: nil, fresh: "fresh"))
        #expect(!bare.usable(observed: "i2", fresh: "fresh"), "a machine that now has an instance is not that bare one")
        #expect(!bare.usable(observed: nil, fresh: "other") && !bare.usable(observed: nil, fresh: nil))
        let window = try String(contentsOf: Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView/MachineViewController+Direct.swift"),
                                encoding: .utf8)
        #expect(window.contains("try await DirectLifecycle.settle("), "the shortcut uses the same rule (DirectSettleTests)")
    }

    // Findings 3 and 4: the native load's own document is passed once; nothing else rides on it.
    @Test func theNativeLoadPassesItsOwnDocumentOnce() {
        let tenure = RouteTenure()
        tenure.passDocument(URL(string: "https://a.example.com/#/agent/s1")!)
        #expect(!tenure.takeDocumentPass(URL(string: "https://a.example.com/other")!), "another document probes")
        tenure.passDocument(page)
        #expect(tenure.takeDocumentPass(URL(string: "https://a.example.com/#/x")!), "its document, whatever the fragment")
        #expect(!tenure.takeDocumentPass(page), "spent: a reload probes")
        tenure.passDocument(page)
        tenure.switched()
        #expect(!tenure.takeDocumentPass(page), "never across a switch")
        tenure.admit()
        tenure.revokeAdmission() // a kept page, or a load that became a sign-in
        #expect(!tenure.takeAdmission())
    }

    @Test func onlyAFragmentMoveIsTheSameDocument() {
        let current = URL(string: "https://a.example.com/#/agents")!
        #expect(NavigationDelegate.isSameDocument(URL(string: "https://a.example.com/#/agent/s1")!, from: current, reload: false, method: "GET"))
        #expect(!NavigationDelegate.isSameDocument(current, from: current, reload: true, method: "GET"), "a reload, the served one included")
        #expect(!NavigationDelegate.isSameDocument(URL(string: "https://a.example.com/#/x")!, from: current, reload: false, method: "POST"))
        #expect(!NavigationDelegate.isSameDocument(URL(string: "https://a.example.com/settings")!, from: current, reload: false, method: "GET"))
        #expect(!NavigationDelegate.isSameDocument(page, from: current, reload: false, method: "GET"), "no fragment: a document")
        #expect(!NavigationDelegate.isSameDocument(URL(string: "https://a.example.com/#/x")!, from: nil, reload: false, method: nil))
    }

    // Finding 8: A's confirm is up when the window switches to B.
    @Test func anOldPagesChooserGetsNothingOnceAndTheFilesStay() {
        let tenure = RouteTenure()
        let held = [URL(fileURLWithPath: "/tmp/a.txt")]
        var answers: [[URL]?] = []
        let chooser = PendingChooser(held: held, owned: tenure.check()) { answers.append($0) }
        tenure.switched()
        #expect(!chooser.settle(chooser.held), "Attach after the switch delivers nothing")
        #expect(answers.count == 1 && answers[0] == nil)
        chooser.cancel()
        #expect(answers.count == 1, "once")
        #expect(chooser.held == held, "the held files are untouched for the next page")
    }

    // The Files picker returns after the switch: the old page gets nothing.
    @Test func aPickerEndingAfterTheSwitchDeliversNothing() {
        let tenure = RouteTenure()
        var answers: [[URL]?] = []
        let chooser = PendingChooser(held: [], owned: tenure.check()) { answers.append($0) }
        tenure.close()
        #expect(!chooser.settle([URL(fileURLWithPath: "/tmp/picked.txt")]))
        #expect(answers.count == 1 && answers[0] == nil)
    }

    @Test func theCurrentPagesChooserGetsItsHeldFiles() {
        let tenure = RouteTenure()
        let held = [URL(fileURLWithPath: "/tmp/a.txt")]
        var got: [URL]?
        let chooser = PendingChooser(held: held, owned: tenure.check()) { got = $0 }
        #expect(chooser.settle(chooser.held) && got == held)
    }

    /// The UIKit window wires these in (type-checked, not run here).
    @Test func theWindowAdmitsEveryDocumentAndSettlesItsChooser() throws {
        let dir = Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView")
        let direct = try String(contentsOf: dir.appendingPathComponent("MachineViewController+Direct.swift"), encoding: .utf8)
        let main = try String(contentsOf: dir.appendingPathComponent("MachineViewController.swift"), encoding: .utf8)
        let flow = try String(contentsOf: dir.appendingPathComponent("DirectFlow.swift"), encoding: .utf8)
        for wiring in ["DocumentVerdict.of(", "tenure.takeDocumentPass(url)", "guard DocumentVerdict.isRouteOrigin(url, host: host)", "tenure.revokeAdmission()", "self.tenure.passDocument(url)",
                       "settlePrompts()", "PendingChooser(held:"] {
            #expect(direct.contains(wiring), "\(wiring)")
        }
        #expect(main.contains("navigation.admitDocument") && main.contains("self.tenure.passDocument(self.lastUrl)"))
        #expect(main.components(separatedBy: "guard let self, owned() else { return }").count + main.components(separatedBy: "guard owned() else { return }").count >= 4,
                "renewal endings checked against the route")
        #expect(flow.contains("keepIfCurrent(") && flow.contains("let epoch = services.directSessions.epoch(host)"))
    }
}

extension DirectAuthTests {
    private func session(_ token: String) -> DirectSession {
        DirectSession(host: "yaran.example.com", token: token, cookieName: "yaran_session_443", instance: "i1", issuedAt: 1, signInId: token + "_id")
    }

    // Finding 5: sign-in A's login is on the wire when sign-in B lands; A's late answer neither
    // replaces nor revokes B, and A's own new token is revoked.
    @Test func aLateLoginNeverReplacesANewerSignIn() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        let epoch = store.epoch("yaran.example.com")
        try store.put(session("tokB")) // B landed while A's login was out
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data())]
        DirectStub.onRequest = nil
        #expect(await DirectLifecycle.keepIfCurrent(session("tokA"), since: epoch, owned: { true }, store: store, auth: auth) == .cancelled)
        #expect(try store.get("yaran.example.com")?.token == "tokB")
        #expect(DirectStub.seen.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tokA"], "only A's own token is revoked")
    }

    // Round 9: the window's document probe is DirectAuth.status, then RouteSelector.probe, then
    // DocumentVerdict.of. The public answer is the compatible i1; the authenticated one, the newer,
    // is too old for the app, or is i2. The verdict follows the newer answer.
    @Test func aDocumentProbeActsOnTheAuthenticatedAnswer() async {
        let stored = DirectSession(host: "yaran.example.com", token: "tokA", cookieName: "yaran_session_443", instance: "i1", issuedAt: 1)
        let tooOld = (200, json, Data(#"{"password_set":true,"required_here":true,"signed_in":true,"transport_encrypted":true,"instance":"i1"}"#.utf8))
        DirectStub.onRequest = nil
        DirectStub.seen = []
        DirectStub.replies = [status("i1"), tooOld]
        let old = await auth.status(host: "yaran.example.com", stored: stored)
        #expect(old == .upgradeRequired)
        #expect(DocumentVerdict.of(probe: RouteSelector.probe(of: old, instance: nil), status: old, seen: "i1") == .refuse)
        #expect(DirectStub.seen.map { $0.value(forHTTPHeaderField: "Cookie") } == [nil, "yaran_session_443=tokA"])

        DirectStub.replies = [status("i1"), status("i2")]
        let other = await auth.status(host: "yaran.example.com", stored: stored)
        #expect(DocumentVerdict.of(probe: RouteSelector.probe(of: other, instance: nil), status: other, seen: "i1") == .reselect)
        #expect(RouteSelector.probe(of: other, instance: "i1") == .mismatch, "and a recorded instance mismatches")
        DirectStub.replies = []
    }

    // The machine was removed while the login was out: nothing comes back.
    @Test func aLateLoginNeverRecreatesARemovedMachine() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        try store.put(session("tokOld"))
        let epoch = store.epoch("yaran.example.com")
        try store.delete("yaran.example.com")
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data())]
        #expect(await DirectLifecycle.keepIfCurrent(session("tokA"), since: epoch, owned: { true }, store: store, auth: auth) == .cancelled)
        #expect(try store.get("yaran.example.com") == nil)
        #expect(DirectStub.seen.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tokA"])
    }

    // The window moved on during the login: same; with nothing in between it is kept.
    @Test func aLateLoginOfAWindowThatMovedOnIsRevokedAndACurrentOneKept() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data())]
        #expect(await DirectLifecycle.keepIfCurrent(session("tokA"), since: store.epoch("yaran.example.com"), owned: { false }, store: store,
                                                    auth: auth) == .cancelled)
        #expect(try store.get("yaran.example.com") == nil && DirectStub.seen.count == 1)
        let kept = await DirectLifecycle.keepIfCurrent(session("tokC"), since: store.epoch("yaran.example.com"), owned: { true }, store: store, auth: auth)
        #expect(kept == .signedIn(host: "yaran.example.com", instance: "i1", signInId: "tokC_id"))
        #expect(try store.get("yaran.example.com")?.token == "tokC")
    }
}
