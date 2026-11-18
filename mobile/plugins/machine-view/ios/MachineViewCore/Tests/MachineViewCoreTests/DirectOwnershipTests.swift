/// DirectOwnershipTests: the window's cookie steps and the unconditional sign-out under
/// concurrent change (Sol native review round 4).
///
/// A cookie injection checks that its window is still open before every change and after every
/// await, so a window closed mid-way leaves the host's store (which a newer window may use)
/// alone. A sign-out with no `signInId` deletes a record only once every session it held was
/// revoked: sign-ins landing during three revocations in a row leave the newest one current.
/// These run the logic over a fake jar and a stubbed machine; the `WKHTTPCookieStore`
/// conformance and the controller's `closed` wiring are not exercised here (no UIKit host).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/DirectOwnershipTests
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/Fakes (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/DirectOwnershipTests
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/RouteTenureTests (inferred)
/// ├── MachineViewCoreTests/StoreTests (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
private final class FakeJar: DirectCookieJar {
    var cookies: [HTTPCookie]
    var log: [String] = []
    /// Runs inside each await: what closing the window meanwhile would do.
    var during: (() -> Void)?

    init(_ cookies: [HTTPCookie]) { self.cookies = cookies }

    func allCookies() async -> [HTTPCookie] {
        during?()
        return cookies
    }

    func deleteCookie(_ cookie: HTTPCookie) async {
        log.append("delete \(cookie.name)")
        cookies.removeAll { $0.name == cookie.name }
        during?()
    }

    func setCookie(_ cookie: HTTPCookie) async {
        log.append("set \(cookie.name)")
        cookies.append(cookie)
        during?()
    }
}

private func cookie(_ name: String, _ host: String = "a.example.com") -> HTTPCookie {
    HTTPCookie(properties: [.name: name, .value: "v", .domain: host, .path: "/"])!
}

@MainActor
struct DirectOwnershipTests {
    @Test func anOpenWindowDropsTheHostsCookiesThenSetsItsOwn() async {
        let jar = FakeJar([cookie("old1"), cookie("old2"), cookie("other", "b.example.com")])
        #expect(await DirectLifecycle.inject(host: "a.example.com", dropped: true, cookie: cookie("yaran_session_443"), into: jar) { true })
        #expect(jar.log == ["delete old1", "delete old2", "set yaran_session_443"])
    }

    @Test func aWindowClosedMidwayChangesNothingMore() async {
        let jar = FakeJar([cookie("old1"), cookie("old2")])
        var open = true
        jar.during = { if jar.log.count == 1 { open = false } } // closed while the first delete was on its way
        #expect(await !DirectLifecycle.inject(host: "a.example.com", dropped: true, cookie: cookie("yaran_session_443"), into: jar) { open })
        #expect(jar.log == ["delete old1"], "no second delete and no cookie for the newer window's store")
    }

    @Test func aWindowClosedBeforeTheListChangesNothing() async {
        let jar = FakeJar([cookie("old1")])
        var open = true
        jar.during = { open = false }
        #expect(await !DirectLifecycle.inject(host: "a.example.com", dropped: true, cookie: cookie("yaran_session_443"), into: jar) { open })
        #expect(jar.log.isEmpty)
    }
}

extension DirectAuthTests {
    // A, then B, C and D landing during each revocation: D was never revoked, so it stays.
    @Test func anUnconditionalSignOutNeverDeletesASessionItDidNotRevoke() async throws {
        let store = DirectSessionStore(vault: MemoryVault())
        func put(_ token: String) { try? store.put(DirectSession(host: "yaran.example.com", token: token, cookieName: "yaran_session_443",
                                                                 instance: "i1", issuedAt: 1, signInId: token + "_id")) }
        put("tokA")
        let next = ["Bearer tokA": "tokB", "Bearer tokB": "tokC", "Bearer tokC": "tokD"]
        DirectStub.seen = []
        DirectStub.replies = [(204, [:], Data()), (204, [:], Data()), (204, [:], Data())]
        DirectStub.onRequest = { req in next[req.value(forHTTPHeaderField: "Authorization") ?? ""].map(put) }
        defer { DirectStub.onRequest = nil }
        var cleared = 0
        #expect(await DirectLifecycle.signOut(host: "yaran.example.com", signInId: nil, store: store, auth: auth) { cleared += 1 } == .notCurrent)
        #expect(DirectStub.seen.compactMap { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer tokA", "Bearer tokB", "Bearer tokC"])
        #expect(try store.get("yaran.example.com")?.token == "tokD" && cleared == 0, "D and its web data stay")
    }
}
