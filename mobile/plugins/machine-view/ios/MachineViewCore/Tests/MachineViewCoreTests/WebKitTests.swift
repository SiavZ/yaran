/// Tests for the UIKit-free WebKit pieces: cookie, data stores, navigation delegate wiring.
///
/// The cookie is host-only, Secure, SameSite=Lax and session-only, and a real per-machine
/// WebKit data store shows it after `inject` and drops it after `clear`; data-store ids are
/// stable per host and distinct across hosts; the delegate turns policy decisions into the
/// right closure calls and classifies load failures.
///
/// - Main actor; uses macOS WebKit, which shares these APIs with iOS.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/WebKitTests
/// ├── MachineViewCore/CookieInjector (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/DataStores (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// └── MachineViewCore/NavigationPolicy (inferred)
/// External: Foundation, Testing, WebKit
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
import WebKit
@testable import MachineViewCore

@MainActor @Suite struct WebKitTests {
    @Test func cookieShape() throws {
        let c = try #require(CookieInjector.httpCookie(host: "laptop-ada.example.com", value: "a.b.c"))
        #expect(c.name == "CF_Authorization" && c.value == "a.b.c" && c.path == "/")
        #expect(c.domain == "laptop-ada.example.com") // host-only: no leading dot
        #expect(c.isSecure && c.isSessionOnly && c.expiresDate == nil)
        #expect(c.sameSitePolicy == .sameSiteLax)
    }

    @Test func injectThenClearOnARealStoreThenRemoveIt() async throws {
        let host = "cookie-test.example.invalid"
        do {
            let dataStore = DataStores.store(host: host) // the web view holds it in the app
            let store = dataStore.httpCookieStore
            let cookie = try CookieSpec.make(kind: .accessJwt, jwt: "a.b.c", cookie: nil)
            #expect(await CookieInjector.inject(cookie, host: host, into: store))
            // Observed on macOS WebKit: the undocumented HttpOnly key is honored (T61 stays UNVERIFIED on iOS).
            #expect(await store.allCookies().first { $0.name == CookieSpec.name }?.isHTTPOnly == true)
            await CookieInjector.clear(host: host, in: store)
            #expect(await !CookieInjector.present(host: host, value: "a.b.c", in: store))
        }
        // The store can go once nothing holds it; the network process lets go asynchronously.
        var removed = false
        for _ in 0..<30 where !removed {
            removed = (try? await DataStores.remove(host: host)) != nil
            if !removed { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        #expect(removed)
    }

    @Test func dataStoreIdentifiers() {
        let a = DataStores.identifier(host: "a.example.com")
        #expect(a == DataStores.identifier(host: "a.example.com"))
        #expect(a != DataStores.identifier(host: "b.example.com"))
        #expect(a.uuidString.dropFirst(14).first == "5")
    }

    @Test func delegateRoutesDecisions() {
        let d = NavigationDelegate(pinnedHost: "laptop-ada.example.com", diagnostics: nil)
        var actions: [(NavigationDecision, String)] = [], loads: [String] = []
        d.onAction = { actions.append(($0, $1.absoluteString)) }
        func run(_ s: String, newWindow: Bool = false, gesture: Bool = true) -> Bool {
            d.apply(url: URL(string: s), mainFrame: true, newWindow: newWindow, gesture: gesture) { loads.append($0.absoluteString) }
        }
        #expect(run("https://laptop-ada.example.com/x"))
        #expect(!run("https://laptop-ada.example.com/e", newWindow: true))
        #expect(!run("yaranapp://home"))
        #expect(!run("https://github.com/"))
        #expect(!run("https://github.com/", gesture: false))
        #expect(!run("https://team.cloudflareaccess.com/"))
        #expect(loads == ["https://laptop-ada.example.com/e"])
        #expect(actions.map(\.0) == [.closeHome, .external, .reauth])
    }

    @Test func loadFailureClassification() {
        #expect(NavigationDelegate.classify(NSError(domain: NSURLErrorDomain, code: NSURLErrorServerCertificateUntrusted)) == .tls)
        #expect(NavigationDelegate.classify(NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)) == .offline)
        #expect(NavigationDelegate.classify(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)) == nil)
        #expect(NavigationDelegate.classify(NSError(domain: "WebKitErrorDomain", code: 102)) == nil)
    }
}
