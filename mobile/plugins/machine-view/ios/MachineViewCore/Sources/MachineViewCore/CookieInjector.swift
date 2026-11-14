/// Puts the `CF_Authorization` session cookie into a WKWebView cookie store, and takes it out.
///
/// The cookie is written, then confirmed present with `allCookies()` before the caller loads
/// (WebKit's `setCookie` completion means stored, not visible to the next request; Apple DTS
/// advises re-applying critical cookies before each load), with an optional G6 poll. It is a
/// session cookie with no `Expires`, so it never reaches WebKit's on-disk store.
///
/// - Main actor (WKHTTPCookieStore). HttpOnly has no public property key, so it is set by the
///   documented-by-name `HttpOnly` key and is UNVERIFIED (threat-model T61).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/CookieInjector
/// ├── MachineViewCore/CookieSpec (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation, WebKit
///
/// Used by:
/// MachineViewCore/CookieInjector
/// ├── MachineView/MachineViewController (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>
#if canImport(WebKit)
import Foundation
import WebKit

@MainActor
public enum CookieInjector {
    static let httpOnlyKey = HTTPCookiePropertyKey("HttpOnly")

    /// The host-only session cookie for `host` (no leading dot in the domain, no expiry).
    public static func httpCookie(host: String, value: String) -> HTTPCookie? {
        HTTPCookie(properties: [
            .name: CookieSpec.name, .value: value, .domain: host, .path: "/", .secure: "TRUE",
            .discard: "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteLax, httpOnlyKey: "TRUE",
        ])
    }

    /// Writes the cookie and returns whether the store then shows it for `host`.
    public static func inject(_ cookie: InjectedCookie, host: String, into store: WKHTTPCookieStore,
                              pollMs: Int = Fallbacks.cookiePollMs) async -> Bool {
        guard let http = httpCookie(host: host, value: cookie.value) else { return false }
        await store.setCookie(http)
        let deadline = Date().addingTimeInterval(Double(pollMs) / 1000)
        repeat {
            if await present(host: host, value: cookie.value, in: store) { return true }
            guard pollMs > 0 else { break }
            try? await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        return false
    }

    /// Deletes `CF_Authorization` and `CF_AppSession` for `host`.
    public static func clear(host: String, in store: WKHTTPCookieStore) async {
        for c in await store.allCookies() where c.domain == host && CookieSpec.clearNames.contains(c.name) {
            await store.deleteCookie(c)
        }
    }

    static func present(host: String, value: String, in store: WKHTTPCookieStore) async -> Bool {
        await store.allCookies().contains { $0.domain == host && $0.name == CookieSpec.name && $0.value == value }
    }
}
#endif
