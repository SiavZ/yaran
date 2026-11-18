/// DirectRepairTests: the review-round regressions of the direct-machine rules (instance-scoped
/// records, org-scoped sessions, reload bookkeeping, share ownership, sign-in ids and conditional
/// sign-out, credentials only for the expected bound instance, the org API, inbox containment,
/// every handoff ending releasing the hold).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/DirectRepairTests
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCore/ShareInbox (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct RepairRoundTests {
    // F1: a record from the instance before a kept change is dropped, never handed back.
    @Test func aRecordFromAnotherInstanceIsDroppedNotReused() throws {
        let vault = MemoryVault()
        let store = DirectSessionStore(vault: vault)
        try store.put(DirectSession(host: "a.example.com", token: "tokOld", cookieName: "yaran_session_443", instance: "i-old", issuedAt: 1))
        let kept = try store.current("a.example.com", instance: "i-new")
        #expect(kept.session == nil && kept.dropped)
        #expect(vault.items["session-direct/a.example.com"] == nil)
        try store.put(DirectSession(host: "a.example.com", token: "tok", cookieName: "yaran_session_443", instance: "i-new", issuedAt: 2))
        let same = try store.current("a.example.com", instance: "i-new")
        #expect(same.session?.token == "tok" && !same.dropped)
        #expect(try store.current("b.example.com", instance: "i-new") == (session: nil, dropped: false))
    }

    // F2: another org's session for the same host is no session for this route.
    @Test func anotherOrgsSessionIsNotThisRoutes() throws {
        let sessions = SessionStore(vault: MemoryVault(), diagnostics: nil)
        try sessions.put(orgId: "https://other.example.com", payload: payload(host: "a.example.com", exp: 9_999_999_999), kind: .accessJwt)
        #expect(try sessions.get("a.example.com", orgId: "https://cp.example.com") == nil)
        #expect(try sessions.get("a.example.com", orgId: "https://other.example.com") != nil)
    }

    // F8/F9: a renderer lost behind the lock reloads exactly once at the resume; healthy resumes never reload.
    @Test func reloadsHappenOnlyWhenOwed() {
        var reloads = PageReload()
        #expect(!reloads.owed, "an ordinary resume only re-injects")
        let lockedNow = reloads.contentTerminated(locked: true)
        #expect(!lockedNow, "nothing loads behind the lock")
        #expect(reloads.owed, "the unlock's resume owes the reload")
        // F9: a resume whose route choice loaded nothing (all routes offline) keeps it owed.
        #expect(reloads.owed)
        reloads.loaded() // the later healthy route's navigation was submitted
        #expect(!reloads.owed, "and only once")
        let unlockedNow = reloads.contentTerminated(locked: false)
        #expect(unlockedNow, "an unlocked crash reloads at once")
        // Round 10: that reload's admission found the machine offline, so nothing was submitted.
        #expect(reloads.owed, "still owed: the next healthy resume reloads instead of only re-injecting")
        reloads.loaded()
        #expect(!reloads.owed)
    }

    /// The window settles what is owed only where a navigation is submitted, and asks it at resume
    /// (type-checked, not run here).
    @Test func theWindowSettlesAReloadOnlyWhenItLoads() throws {
        let dir = Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView")
        let main = try String(contentsOf: dir.appendingPathComponent("MachineViewController.swift"), encoding: .utf8)
        let direct = try String(contentsOf: dir.appendingPathComponent("MachineViewController+Direct.swift"), encoding: .utf8)
        let source = main + direct
        #expect(source.components(separatedBy: "reloads.loaded()").count - 1 == 2, "the two load paths, nowhere else")
        #expect(main.contains("self.reloads.loaded() // settled only by a navigation actually submitted\n            self.tenure.passDocument(self.lastUrl)\n            self.webView.load("))
        #expect(direct.contains("self.reloads.loaded() // settled only by a navigation actually submitted\n            self.tenure.passDocument(url)\n            self.webView.load("))
        #expect(direct.contains("select(current: chosen, retry: reloads.owed)") && direct.contains("else if reloads.owed { loadRoute(nil) }"))
    }

    // F10: closing an older window deletes only its own files, never a newer pending share.
    @Test func aWindowRemovesOnlyItsOwnSharedFiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        func file(_ name: String) throws -> URL {
            let url = source.appendingPathComponent(name)
            try Data(name.utf8).write(to: url)
            return url
        }
        let inbox = ShareInbox(dir: root.appendingPathComponent("inbox"), incomingRoot: root.appendingPathComponent("Documents/Inbox"))
        _ = inbox.intake([try file("a1"), try file("a2")], supported: true)
        let ownedByA = inbox.take()
        _ = inbox.intake([try file("b1")], supported: true)
        #expect(inbox.count == 1)
        let outside = try file("outside")
        // A same-length lookalike of the inbox path naming B's batch must not reach B.
        let batchB = inbox.held[0].deletingLastPathComponent().deletingLastPathComponent().lastPathComponent
        let lookalike = root.appendingPathComponent("inboz").appendingPathComponent(batchB).appendingPathComponent("0/b1")
        inbox.remove(ownedByA + [outside, root.appendingPathComponent("inbox"), lookalike])
        #expect(ownedByA.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        #expect(inbox.count == 1 && FileManager.default.fileExists(atPath: inbox.held[0].path), "the newer share stays")
        #expect(FileManager.default.fileExists(atPath: outside.path), "nothing outside the inbox is deleted")
        _ = inbox.intake([try file("c1")], supported: true)
        #expect(inbox.count == 1 && inbox.held[0].lastPathComponent == "c1", "a held share is replaced by the next one")
    }
}

extension DirectAuthTests {
    private func session(_ token: String, _ id: String?, instance: String? = "i1") -> DirectSession {
        DirectSession(host: "yaran.example.com", token: token, cookieName: "yaran_session_443", instance: instance, issuedAt: 1, signInId: id)
    }

    // F1: shell A returned signed_in, sign-in B replaced it, then A's cleanup ran.
    @Test func aCleanupEndsOnlyItsOwnSignInAndAReplacedOneIsRevoked() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        DirectStub.seen = []; DirectStub.replies = []; DirectStub.onRequest = nil
        #expect(await DirectLifecycle.keep(session("tokA", "idA"), store: store, auth: auth) == .signedIn(host: "yaran.example.com", instance: "i1", signInId: "idA"))
        #expect(DirectStub.seen.isEmpty)
        DirectStub.replies = [(204, [:], Data())]
        _ = await DirectLifecycle.keep(session("tokB", "idB"), store: store, auth: auth)
        #expect(DirectStub.seen.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tokA"], "the replaced sign-in is revoked")
        var cleared = 0
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: "idA", store: store, auth: auth) { cleared += 1 } == .notCurrent)
        #expect(try store.get("yaran.example.com")?.token == "tokB" && cleared == 0 && DirectStub.seen.count == 1)
        DirectStub.replies = [(204, [:], Data())]
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: "idB", store: store, auth: auth) { cleared += 1 } == .signedOut(serverEnded: true))
        #expect(try store.get("yaran.example.com") == nil && cleared == 1)
        try store.put(session("tokOld", nil))
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: "idA", store: store, auth: auth) {} == .notCurrent, "an older build's record is not anyone's id")
    }

    // F1: B lands while A's revocation is on the wire; the re-check keeps B.
    @Test func aSignInThatLandsDuringTheRevocationSurvives() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        try store.put(session("tokA", "idA"))
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data())]
        DirectStub.onRequest = { _ in try? store.put(self.session("tokB", "idB")) }
        defer { DirectStub.onRequest = nil }
        var cleared = 0
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: "idA", store: store, auth: auth) { cleared += 1 } == .notCurrent)
        #expect(DirectStub.seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tokA", "A is revoked")
        #expect(try store.get("yaran.example.com")?.token == "tokB" && cleared == 0, "B and its web data stay")

        // Removing the machine: a sign-in that lands meanwhile is revoked too, never left live.
        try store.put(session("tokA", "idA"))
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data()), (204, [:], Data())]
        DirectStub.onRequest = { req in
            if req.value(forHTTPHeaderField: "Authorization") == "Bearer tokA" { try? store.put(self.session("tokB", "idB")) }
        }
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: nil, store: store, auth: auth) { cleared += 1 } == .signedOut(serverEnded: true))
        #expect(DirectStub.seen.compactMap { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tokA", "Bearer tokB"])
        #expect(try store.get("yaran.example.com") == nil && cleared == 1)
    }

    // F3: an unbound (older) session, or an open expecting another instance, never sends the token.
    @Test func noCredentialBeforeTheExpectedBoundInstance() async {
        DirectStub.onRequest = nil
        DirectStub.seen = []
        DirectStub.replies = [status("i1"), status("i1", signedIn: true)]
        _ = await auth.status(host: "yaran.example.com", stored: session("tokL", nil, instance: nil))
        #expect(DirectStub.seen.count == 1 && DirectStub.seen[0].value(forHTTPHeaderField: "Cookie") == nil)
        DirectStub.seen = []
        DirectStub.replies = [status("i1"), status("i1", signedIn: true)]
        _ = await auth.status(host: "yaran.example.com", stored: session("tokA", "idA"), expected: "i2")
        #expect(DirectStub.seen.count == 1 && DirectStub.seen[0].value(forHTTPHeaderField: "Cookie") == nil)
        DirectStub.replies = []
    }

    // F5: org B's session under org A's control-plane host is never sent for org A, nor deleted.
    @Test func anotherOrgsSessionIsNeverSentToTheOrgApi() async throws {
        let vault = MemoryVault()
        let sessions = SessionStore(vault: vault, diagnostics: nil)
        try sessions.put(orgId: "org-b", payload: payload(host: "cp.example.com", exp: 9_999_999_999, kind: "control_plane"), kind: .accessJwt)
        let orgs = FakeOrgs()
        orgs.urls = ["org-a": "https://cp.example.com"]
        let installs = InstallIdStore(vault: vault)
        let client = OrgApiClient(session: OrgApiClient.makeSession(protocolClasses: [DirectStub.self]), orgs: orgs, sessions: sessions,
                                  installs: installs, deviceKeys: DeviceKeyStore(backend: SoftwareKeyBackend(), installs: installs, diagnostics: nil),
                                  userAgent: "YaranApp/1.0.0 (ios; phone)", cleaner: nil, diagnostics: nil, clock: { 1 })
        DirectStub.seen = []
        let result = await client.request(orgId: "org-a", method: "GET", path: "/v1/me/devices", body: nil)
        guard case .sessionExpired = result else { Issue.record("expected session_expired, got \(result)"); return }
        #expect(DirectStub.seen.isEmpty, "no Cookie or cf-access-token left the phone")
        #expect(try sessions.get("cp.example.com")?.orgId == "org-b")
    }
}

@Suite struct IncomingInboxTests {
    // F10: only iOS's own copy in the real Documents/Inbox is deleted.
    @Test func onlyTheRealInboxCopyIsDeleted() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? fm.removeItem(at: root) }
        let inboxRoot = root.appendingPathComponent("Documents/Inbox", isDirectory: true)
        let lookalike = root.appendingPathComponent("Library/Caches/x/Documents/Inbox", isDirectory: true)
        for dir in [inboxRoot, lookalike] { try fm.createDirectory(at: dir, withIntermediateDirectories: true) }
        func file(_ dir: URL, _ name: String) throws -> URL {
            let url = dir.appendingPathComponent(name)
            try Data(name.utf8).write(to: url)
            return url
        }
        let real = try file(inboxRoot, "real.txt")
        let outside = try file(lookalike, "outside.txt")
        let target = try file(root, "target.txt")
        let link = inboxRoot.appendingPathComponent("link.txt")
        try fm.createSymbolicLink(at: link, withDestinationURL: target)
        let inbox = ShareInbox(dir: root.appendingPathComponent("Library/Caches/shared-inbox"), incomingRoot: inboxRoot)
        _ = inbox.intake([real, outside, link], supported: false)
        #expect(!fm.fileExists(atPath: real.path), "iOS's own copy goes")
        #expect(fm.fileExists(atPath: outside.path), "a look-alike path is someone else's file")
        #expect(fm.fileExists(atPath: target.path), "a link's target is never deleted")
        #expect((try? fm.destinationOfSymbolicLink(atPath: link.path)) != nil, "nor the link itself")
    }
}

/// Counts the external-flow hold, so an ending that leaks it shows.
private final class CountingLock: AppLockState {
    var held = 0
    func lockEnabled() -> Bool { false }
    func isLocked() -> Bool { false }
    func holdForExternalFlow(ttlMs: Int64) { held += 1 }
    func releaseExternalFlow() { if held > 0 { held -= 1 } }
}

@Suite struct HandoffEndingTests {
    // F7: an unknown org, a key failure, a cancel and an error reply each end the sign-in with the hold released.
    @Test func everyEndingReleasesTheHold() throws {
        let rig = HandoffRig()
        let lock = CountingLock()
        let client = HandoffClient(vault: rig.store.vault, deviceKeys: rig.store.keys, sessions: rig.store.sessions(), orgs: rig.orgs,
                                   launcher: rig.launcher, mode: rig.mode, deviceLabel: "x", clock: { rig.now }, diagnostics: nil, appLock: lock)
        var outcomes: [SignInOutcome] = []
        client.signIn(orgId: "org-unknown", request: .controlPlane) { outcomes.append($0) }
        #expect(outcomes == [.refused(code: "unknown_org")] && lock.held == 0)
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes.append($0) }
        #expect(lock.held == 1)
        rig.launcher.completions.last!(.cancelled)
        #expect(outcomes.last == .cancelled && lock.held == 0)
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes.append($0) }
        let state = rig.launcher.lastQuery["state"]!
        rig.launcher.completions.last!(.redirect(URL(string: "\(rig.base)?state=\(state)&error=handoff_declined")!))
        #expect(outcomes.last == .declined && lock.held == 0)
        let broken = DeviceKeyStore(backend: BrokenKeys(), installs: InstallIdStore(vault: MemoryVault()), diagnostics: nil)
        let failing = HandoffClient(vault: MemoryVault(), deviceKeys: broken, sessions: rig.store.sessions(), orgs: rig.orgs,
                                    launcher: rig.launcher, mode: rig.mode, deviceLabel: "x", clock: { rig.now }, diagnostics: nil, appLock: lock)
        failing.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes.append($0) }
        #expect(outcomes.last == .secureStorageFailed && lock.held == 0)
    }

    // Round 6: renewal A is replaced by renewal B, then A's browser comes back late with a redirect.
    // It must not take B's pending state or release B's hold; B still finishes normally, once.
    @Test func aReplacedSignInsLateRedirectLeavesTheNewOneAlone() throws {
        let rig = HandoffRig()
        let lock = CountingLock()
        let client = HandoffClient(vault: rig.store.vault, deviceKeys: rig.store.keys, sessions: rig.store.sessions(), orgs: rig.orgs,
                                   launcher: rig.launcher, mode: rig.mode, deviceLabel: "x", clock: { rig.now }, diagnostics: nil, appLock: lock)
        var outcomes: [String: [SignInOutcome]] = ["a": [], "b": []]
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes["a"]!.append($0) }
        let stateA = rig.launcher.lastQuery["state"]!, endA = rig.launcher.completions.last!
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes["b"]!.append($0) }
        let stateB = rig.launcher.lastQuery["state"]!, endB = rig.launcher.completions.last!
        #expect(stateA != stateB)
        #expect(outcomes["a"] == [.cancelled] && lock.held == 1, "A ended once and gave its hold back; B holds")
        endA(.redirect(URL(string: "\(rig.base)?state=\(stateA)&error=handoff_declined")!))
        endA(.redirect(URL(string: "\(rig.base)?state=\(stateB)&error=handoff_declined")!)) // even naming B's state
        endA(.cancelled)
        #expect(outcomes["a"] == [.cancelled] && outcomes["b"] == [] && lock.held == 1)
        endB(.redirect(URL(string: "\(rig.base)?state=\(stateB)&error=handoff_declined")!))
        #expect(outcomes["b"] == [.declined] && lock.held == 0)
        endB(.cancelled)
        #expect(outcomes["b"] == [.declined] && lock.held == 0, "exactly once")
    }
}
