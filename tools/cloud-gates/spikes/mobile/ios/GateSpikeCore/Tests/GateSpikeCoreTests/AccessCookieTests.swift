/// Swift Testing pins for the iOS machine-view cookie (same cases as the Android JUnit test).
///
/// Checks the exact `Set-Cookie` string, that it is host-only, that SameSite passes through,
/// that Expires equals the JWT `exp`, that non-JWTs and attribute injection are refused, and
/// that Foundation parses the string into the HTTPCookie WKHTTPCookieStore will receive.
///
/// - Swift Testing, not XCTest: the Command Line Tools ship Testing.framework but no
///   XCTest.framework, and `xcodebuild test` runs Swift Testing suites too.
///
/// <module-headers:begin>
/// Uses:
/// GateSpikeCoreTests/AccessCookieTests.swift
/// └── GateSpikeCore/AccessCookie.swift
/// External: Testing, Foundation
///
/// Used by:
/// GateSpikeCoreTests/AccessCookieTests.swift
/// └── entry point (swift test / Swift Testing)
/// <module-headers:end>
import Foundation
import Testing
@testable import GateSpikeCore

private func b64(_ s: String) -> String {
    Data(s.utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

// exp 1767225600 = Thu, 01 Jan 2026 00:00:00 GMT
private let jwt = b64(#"{"alg":"RS256","kid":"k1"}"#) + "." +
    b64(#"{"aud":["a1"],"email":"owner@example.invalid","exp":1767225600,"iat":1767225420,"type":"app"}"#) +
    ".c2lnbmF0dXJl"

@Suite struct AccessCookieTests {
    @Test func exactAttributesWithExpiresFromJwtExp() throws {
        #expect(try AccessCookie.setCookieHeader(jwt: jwt, sameSite: "Lax")
            == "CF_Authorization=\(jwt); Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 2026 00:00:00 GMT")
    }

    @Test func hostOnly() throws {
        #expect(try !AccessCookie.setCookieHeader(jwt: jwt, sameSite: "Lax").lowercased().contains("domain"))
    }

    @Test(arguments: ["Strict", "Lax", "None"])
    func sameSitePassesThrough(_ s: String) throws {
        #expect(try AccessCookie.setCookieHeader(jwt: jwt, sameSite: s).contains("; SameSite=\(s);"))
    }

    @Test func explicitExpOverridesPayload() throws {
        #expect(try AccessCookie.setCookieHeader(jwt: jwt, sameSite: "None", exp: 0)
            .hasSuffix("Expires=Thu, 01 Jan 1970 00:00:00 GMT"))
    }

    @Test func decodesExp() throws {
        #expect(try AccessCookie.jwtExp(jwt) == 1_767_225_600)
    }

    @Test(arguments: ["", "not-a-jwt", "a.b", "a.b.c.d", "\(jwt); Domain=evil.example", "a.b."])
    func rejectsNonJwts(_ bad: String) {
        #expect(throws: AccessCookieError.notAJWT) { try AccessCookie.setCookieHeader(jwt: bad, sameSite: "Lax") }
    }

    @Test func rejectsJwtWithoutExp() {
        let noExp = b64(#"{"alg":"none"}"#) + "." + b64(#"{"aud":"a"}"#) + ".sig"
        #expect(throws: AccessCookieError.noExp) { try AccessCookie.setCookieHeader(jwt: noExp, sameSite: "Lax") }
    }

    @Test func rejectsUnknownSameSite() {
        #expect(throws: AccessCookieError.badSameSite) {
            try AccessCookie.setCookieHeader(jwt: jwt, sameSite: "Lax; Domain=x")
        }
    }

    @Test func foundationParsesItAsAHostOnlySecureHttpOnlyCookie() throws {
        let url = URL(string: "https://gate-m1.example.invalid/")!
        let cookie = try AccessCookie.cookie(jwt: jwt, sameSite: "Lax", url: url)
        #expect(cookie.name == "CF_Authorization")
        #expect(cookie.value == jwt)
        #expect(cookie.domain == "gate-m1.example.invalid", "no leading dot: host-only")
        #expect(cookie.path == "/")
        #expect(cookie.isSecure)
        #expect(cookie.isHTTPOnly)
        #expect(cookie.sameSitePolicy == .sameSiteLax)
        #expect(cookie.expiresDate == Date(timeIntervalSince1970: 1_767_225_600))
    }
}
