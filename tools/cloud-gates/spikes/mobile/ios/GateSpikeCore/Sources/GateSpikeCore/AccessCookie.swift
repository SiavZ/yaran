/// AccessCookie: builds the host-only `CF_Authorization` cookie machine-view injects (G1 L0).
///
/// Produces the exact `Set-Cookie` string the Android spike produces (Path=/, Secure, HttpOnly,
/// the given SameSite, Expires at the JWT's own `exp`, no Domain), then lets Foundation parse
/// it into an `HTTPCookie` for `WKHTTPCookieStore`, so the cookie iOS stores has the same
/// semantics a real Access `Set-Cookie` would.
///
/// - Trust boundary: the JWT comes from a paste field; it must be three base64url segments, so
///   it cannot carry `;` and smuggle extra attributes. SameSite is an allowlist.
/// - The JWT is decoded only to read `exp`; it is never verified here (the server verifies).
///
/// <module-headers:begin>
/// Uses:
/// GateSpikeCore/AccessCookie.swift
/// External: Foundation
///
/// Used by:
/// GateSpikeCore/AccessCookie.swift
/// ├── App/MachineViewSpike.swift
/// └── GateSpikeCoreTests/AccessCookieTests.swift
/// <module-headers:end>
import Foundation

public enum AccessCookieError: Error, Equatable {
    case notAJWT
    case badSameSite
    case noExp
    case unparseable
}

public enum AccessCookie {
    public static let sameSiteValues: Set<String> = ["Strict", "Lax", "None"]
    private static let base64url = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")

    /// `CF_Authorization=<jwt>; Path=/; Secure; HttpOnly; SameSite=<x>; Expires=<RFC 1123 GMT>`.
    public static func setCookieHeader(jwt: String, sameSite: String, exp: Int64? = nil) throws -> String {
        guard isJWTShaped(jwt) else { throw AccessCookieError.notAJWT }
        guard sameSiteValues.contains(sameSite) else { throw AccessCookieError.badSameSite }
        let expires = rfc1123(try exp ?? jwtExp(jwt))
        return "CF_Authorization=\(jwt); Path=/; Secure; HttpOnly; SameSite=\(sameSite); Expires=\(expires)"
    }

    /// The header parsed by Foundation for `url`, exactly as a server response would be.
    public static func cookie(jwt: String, sameSite: String, url: URL, exp: Int64? = nil) throws -> HTTPCookie {
        let header = try setCookieHeader(jwt: jwt, sameSite: sameSite, exp: exp)
        let parsed = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url)
        guard parsed.count == 1, let cookie = parsed.first else { throw AccessCookieError.unparseable }
        return cookie
    }

    /// Reads `exp` from the unverified payload segment.
    public static func jwtExp(_ jwt: String) throws -> Int64 {
        let parts = jwt.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else { throw AccessCookieError.notAJWT }
        var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { throw AccessCookieError.notAJWT }
        guard let exp = obj["exp"] as? NSNumber else { throw AccessCookieError.noExp }
        return exp.int64Value
    }

    public static func rfc1123(_ epochSeconds: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(epochSeconds)))
    }

    private static func isJWTShaped(_ s: String) -> Bool {
        let parts = s.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 3 && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy(base64url.contains) }
    }
}
