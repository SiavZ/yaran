/// The `CF_Authorization` session cookie machine-view injects, and the cookies that clear it.
///
/// Host-only (no `Domain`), `Path=/`, Secure, HttpOnly, SameSite=Lax and no `Expires`, so the
/// JWT never lands in the WebView's on-disk cookie store (the vault stays the only place it
/// rests). The value is the payload's `jwt`, or its `cookie` field under G1 rung 1. Pinned by
/// `fixtures/cookie-cases.json` with its Kotlin twin.
///
/// - Pure. A value outside `[A-Za-z0-9._-]{1,4096}` is refused, so no attribute can be injected.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/CookieSpec
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/CookieSpec
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/CookieInjector (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>
import Foundation

public enum CredentialKind: String, Codable, Equatable {
    case accessJwt
    case accessCookie
    case managedOAuth
}

public enum CookieSpecError: Error, Equatable {
    case invalidValue
    /// managedOAuth credentials travel as a header, never as a cookie (G1 step 2).
    case notACookieCredential
}

public struct InjectedCookie: Equatable {
    public enum Source: String { case jwt, cookie }
    public let value: String
    public let setCookie: String
    public let used: Source
    /// Rung 1 was asked for but the payload had no cookie field.
    public let diagnostic: Bool
}

public enum CookieSpec {
    public static let name = "CF_Authorization"
    private static let valueRe = Pattern("[A-Za-z0-9._-]{1,4096}")
    private static let clearTail = "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"

    public static let clearCookies = ["CF_Authorization" + clearTail, "CF_AppSession" + clearTail]
    public static let clearNames = ["CF_Authorization", "CF_AppSession"]

    public static func cookieUrl(host: String) -> String { "https://\(host)/" }

    public static func make(kind: CredentialKind, jwt: String, cookie: String?) throws -> InjectedCookie {
        let value: String
        let used: InjectedCookie.Source
        var diagnostic = false
        switch kind {
        case .accessJwt:
            (value, used) = (jwt, .jwt)
        case .accessCookie:
            if let cookie { (value, used) = (cookie, .cookie) } else { (value, used, diagnostic) = (jwt, .jwt, true) }
        case .managedOAuth:
            throw CookieSpecError.notACookieCredential
        }
        guard valueRe.matches(value) else { throw CookieSpecError.invalidValue }
        return InjectedCookie(value: value, setCookie: "\(name)=\(value); Path=/; Secure; HttpOnly; SameSite=Lax",
                              used: used, diagnostic: diagnostic)
    }
}
