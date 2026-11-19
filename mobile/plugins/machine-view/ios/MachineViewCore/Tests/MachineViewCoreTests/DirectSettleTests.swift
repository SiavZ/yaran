/// DirectSettleTests: every direct sheet-or-proceed decision reads the session first (Sol native
/// review round 12).
///
/// `DirectLifecycle.settle` over a memory vault and a fake cookie jar: a stale instance's record
/// and cookies are gone before a password is asked; a window's own fresh sign-in on an
/// instance-less machine asks for none. `OpenPrompts` keeps one password attempt per route. The
/// UIKit controller's use of both is pinned by reading its source; it is not run here.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/DirectSettleTests
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/PendingChooser (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/DirectSettleTests
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// ├── MachineViewCoreTests/OrgWipeTests (inferred)
/// ├── MachineViewCoreTests/PolicyTests (inferred)
/// ├── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// ├── MachineViewCoreTests/RouteTenureTests (inferred)
/// ├── MachineViewCoreTests/StoreTests (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
private final class SettleJar: DirectCookieJar {
    var cookies: [HTTPCookie]
    var during: (() -> Void)?
    init(_ cookies: [HTTPCookie]) { self.cookies = cookies }
    func allCookies() async -> [HTTPCookie] { during?(); return cookies }
    func deleteCookie(_ cookie: HTTPCookie) async { cookies.removeAll { $0.name == cookie.name }; during?() }
    func setCookie(_ cookie: HTTPCookie) async { cookies.append(cookie) }
}

private let host = "a.example.com"
private let sessionCookie = HTTPCookie(properties: [.name: "yaran_session_443", .value: "tokA", .domain: host, .path: "/"])!

private func asks(instance: String?, signedIn: Bool = false) -> DirectStatus {
    .yaran(instance: instance, passwordSet: true, requiredHere: true, signedIn: signedIn, transportEncrypted: true)
}

@MainActor
struct DirectSettleTests {
    private func store(instance: String?, signInId: String? = nil) throws -> DirectSessionStore {
        let store = DirectSessionStore(vault: MemoryVault())
        try store.put(DirectSession(host: host, token: "tokA", cookieName: "yaran_session_443", instance: instance, issuedAt: 1, signInId: signInId))
        return store
    }

    // Signed in at i1, back to i2: the i1 record and its cookie are gone before the password is asked.
    @Test func anotherInstanceDropsTheOldSessionBeforeTheSheet() async throws {
        let store = try store(instance: "i1")
        let jar = SettleJar([sessionCookie])
        let settle = try await DirectLifecycle.settle(host: host, status: asks(instance: "i2"), observed: "i2", fresh: nil, store: store, jar: jar) { true }
        #expect(settle == .signIn)
        #expect(try store.get(host) == nil)
        #expect(jar.cookies.isEmpty)
    }

    // An instance-less machine this window signed in to itself: no second password.
    @Test func anInstanceLessMachinesFreshSessionAsksForNone() async throws {
        let store = try store(instance: nil, signInId: "s1")
        let jar = SettleJar([sessionCookie])
        let settle = try await DirectLifecycle.settle(host: host, status: asks(instance: nil), observed: nil, fresh: "s1", store: store, jar: jar) { true }
        #expect(settle == .proceed)
        #expect(try store.get(host) != nil && jar.cookies.count == 1)
    }

    // The window moves on while the stale cookies are being cleared: no sheet, nothing more cleared.
    @Test func aWindowThatMovedOnMidCleanupAsksNothing() async throws {
        let store = try store(instance: "i1")
        var open = true
        let jar = SettleJar([sessionCookie])
        jar.during = { open = false }
        #expect(try await DirectLifecycle.settle(host: host, status: asks(instance: "i2"), observed: "i2", fresh: nil, store: store, jar: jar) { open } == nil)
    }

    @Test func aGoneWindowReadsAndDeletesNothing() async throws {
        let store = try store(instance: "i1")
        let jar = SettleJar([sessionCookie])
        #expect(try await DirectLifecycle.settle(host: host, status: asks(instance: "i2"), observed: "i2", fresh: nil, store: store, jar: jar) { false } == nil)
        #expect(try store.get(host) != nil && jar.cookies.count == 1)
    }

    // Two asks before the first preflight answered: one attempt. The route change ends it, the
    // next route's attempt starts, and the old attempt's late ending frees nothing of it.
    @Test func onePasswordAttemptPerRoute() {
        let prompts = OpenPrompts()
        let first = prompts.reserveSignIn()
        #expect(first != nil)
        #expect(prompts.reserveSignIn() == nil, "the overlapping ask")
        prompts.settleAll() // route change or close
        let next = prompts.reserveSignIn()
        #expect(next != nil && next != first)
        prompts.releaseSignIn(first!)
        #expect(prompts.reserveSignIn() == nil, "the old ending left the new attempt held")
        prompts.releaseSignIn(next!)
        #expect(prompts.reserveSignIn() != nil)
    }

    @Test func theWindowSettlesEveryDirectDecisionThisWay() throws {
        let dir = Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView")
        let direct = try String(contentsOf: dir.appendingPathComponent("MachineViewController+Direct.swift"), encoding: .utf8)
        for wiring in ["settleDirect(statuses[index]) { [weak self] in self?.reinjectDirect() }", // the kept route's resume
                       "settleDirect(status) { [weak self] in self?.loadDirect() }", // initial, reselection, every load
                       "try await DirectLifecycle.settle(", "guard let attempt = prompts.reserveSignIn() else { return }",
                       "self?.prompts.releaseSignIn(attempt)",
                       #"target.kind == "direct", case .yaran? = statuses[current]"#] {
            #expect(direct.contains(wiring), "\(wiring)")
        }
        #expect(!direct.contains("needsPassword"), "no decision outside the shared settle")
        // The probe's own read (its cookie for the probe) is the one plain read; no decision rests on it.
        #expect(direct.components(separatedBy: "directSessions.get(").count == 2, "no session read that skips the stale cleanup")
    }
}
