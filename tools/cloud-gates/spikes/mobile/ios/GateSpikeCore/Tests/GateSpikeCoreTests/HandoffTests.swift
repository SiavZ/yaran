/// Swift Testing pins for the G13 consent URL and the secret-free callback summary.
///
/// Checks the consent URL's parameters for both build shapes, that a bad consent host is
/// refused, that `state` is 32 random bytes in base64url, and that a callback summary records
/// names, the state check and `jwe`/`error` presence without the `jwe` value.
///
/// - Swift Testing (see AccessCookieTests.swift for why not XCTest).
///
/// <module-headers:begin>
/// Uses:
/// GateSpikeCoreTests/HandoffTests
/// └── GateSpikeCore/Handoff (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (swift test / Swift Testing)
/// <module-headers:end>
import Foundation
import Testing
@testable import GateSpikeCore

private func query(_ url: URL) -> [String: String] {
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    return Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
}

@Suite struct HandoffTests {
    @Test func releaseShapedConsentURL() throws {
        let url = try #require(Handoff.consentURL(consentHost: "gate-cp.example.invalid", state: "s1",
                                                  build: .release, callbackHost: "gate-cb.example.invalid",
                                                  device: "iPhone gate"))
        #expect(url.host == "gate-cp.example.invalid")
        #expect(url.path == "/v1/handoff")
        #expect(query(url) == ["state": "s1", "redirect": "https://gate-cb.example.invalid/auth/callback",
                               "build": "release", "device": "iPhone gate"])
    }

    @Test func devShapedConsentURLUsesTheSpikeScheme() throws {
        let url = try #require(Handoff.consentURL(consentHost: "localhost:8787", state: "s", build: .dev,
                                                  callbackHost: "unused", device: "d"))
        #expect(url.port == 8787)
        #expect(query(url)["redirect"] == "yaranapp-gate://auth/callback")
        #expect(query(url)["build"] == "dev")
    }

    @Test(arguments: ["", "evil.example/path", "https://x", "a b", "x:notaport"])
    func rejectsNonHostConsentHost(_ bad: String) {
        #expect(Handoff.consentURL(consentHost: bad, state: "s", build: .release, callbackHost: "c", device: "d") == nil)
    }

    @Test func stateIs32BytesBase64url() {
        let s = Handoff.randomState()
        #expect(s.count == 43)
        #expect(s.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        #expect(s != Handoff.randomState())
    }

    @Test func summaryHasNamesStateAndPresenceButNoJweValue() {
        let url = URL(string: "https://gate-cb.example.invalid/auth/callback?state=abc&jwe=SECRETVALUE")!
        let s = Handoff.summarize(url, expectedState: "abc")
        #expect(s.paramNames == ["state", "jwe"])
        #expect(s.stateOk)
        #expect(s.hasJwe)
        #expect(!s.hasError)
        #expect(s.detail == "https://gate-cb.example.invalid/auth/callback")
        #expect(!String(describing: s).contains("SECRETVALUE"))
    }

    @Test func summaryFlagsStateMismatchAndDeclinedConsent() {
        let url = URL(string: "yaranapp-gate://auth/callback?state=other&error=handoff_declined")!
        let s = Handoff.summarize(url, expectedState: "abc")
        #expect(!s.stateOk)
        #expect(s.error == "handoff_declined")
        #expect(!Handoff.summarize(nil, expectedState: "abc").stateOk)
    }
}
