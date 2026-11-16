/// Fixture tests for the wire-format twins: cookie, callback, handoff URL, label, UA, messages.
///
/// Reads `fixtures/{cookie,callback,handoff-url,device-labels,messages}*.json` and the
/// protocol's `uri/handoff-redirect.json` and `ua/ua.json`, asserting every case by name.
///
/// - Pure.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/FormatTests
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/DeviceLabel (inferred)
/// ├── MachineViewCore/HandoffUrl (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/UaToken (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/FormatTests
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct FormatTests {
    @Test func cookieCases() throws {
        let fixture = Fixtures.plugin("cookie-cases.json")
        let clear = try #require(fixture["clear"] as? [String])
        #expect(CookieSpec.clearCookies == clear)
        for entry in Fixtures.cases(fixture) {
            let want = try #require(entry["expect"] as? [String: Any])
            let kindName = try #require(entry["credential_kind"] as? String)
            let kind = try #require(CredentialKind(rawValue: kindName))
            let jwt = try #require(entry["jwt"] as? String)
            do {
                let result = try CookieSpec.make(kind: kind, jwt: jwt, cookie: entry["cookie"] as? String)
                #expect(result.setCookie == want["set_cookie"] as? String, "\(entry["name"]!)")
                #expect(result.used.rawValue == want["used"] as? String, "\(entry["name"]!)")
                #expect(result.diagnostic == want["diagnostic"] as? Bool, "\(entry["name"]!)")
            } catch {
                #expect(want["error"] as? String == "invalid_value" && error as? CookieSpecError == .invalidValue, "\(entry["name"]!)")
            }
        }
        #expect(throws: CookieSpecError.notACookieCredential) { try CookieSpec.make(kind: .managedOAuth, jwt: "a.b.c", cookie: nil) }
        #expect(CookieSpec.cookieUrl(host: "h.example.com") == "https://h.example.com/")
    }

    @Test func callbackCases() throws {
        let fixture = Fixtures.plugin("callback-cases.json")
        let ttl = try #require(fixture["ttl_s"] as? Int64)
        #expect(CallbackUrl.ttlS == ttl)
        for entry in Fixtures.cases(fixture) {
            let mode: CallbackMode = try #require(entry["mode"] as? String) == "dev" ? .dev : .https(domain: try #require(entry["domain"] as? String))
            var pending: PendingState?
            if let stored = entry["pending"] as? [String: Any] {
                pending = PendingState(state: try #require(stored["state"] as? String), createdAt: try #require(stored["created_at"] as? Int64))
            }
            let result = CallbackUrl.parse(mode: mode, uri: try #require(entry["uri"] as? String), pending: pending, now: try #require(entry["now"] as? Int64))
            let want = try #require(entry["expect"] as? [String: Any])
            let expected: CallbackResult
            switch try #require(want["result"] as? String) {
            case "success": expected = .success(jwe: try #require(want["jwe"] as? String))
            case "error":
                expected = .error(code: try #require(want["code"] as? String), min: want["min"] as? Int, max: want["max"] as? Int,
                                  serverTime: want["server_time"] as? Int64)
            default: expected = .refused(try #require((want["reason"] as? String).flatMap(CallbackRefusal.init(rawValue:))))
            }
            #expect(result == expected, "\(entry["name"]!)")
        }
    }

    @Test func handoffUrlCases() throws {
        for entry in Fixtures.cases(Fixtures.plugin("handoff-url-cases.json")) {
            let given = try #require(entry["params"] as? [String: Any])
            let target: HandoffTarget = try #require(entry["target"] as? String) == "machine"
                ? .machine(host: try #require(entry["host"] as? String)) : .controlPlane(orgUrl: try #require(entry["org_url"] as? String))
            let mode: CallbackMode = try #require(entry["mode"] as? String) == "dev" ? .dev : .https(domain: try #require(entry["domain"] as? String))
            let params = HandoffParams(pk: try #require(given["pk"] as? String), state: try #require(given["state"] as? String),
                                       device: try #require(entry["device"] as? String), dk: try #require(given["dk"] as? String),
                                       dts: try #require((given["dts"] as? String).flatMap { Int64($0) }), dsig: try #require(given["dsig"] as? String))
            let url = HandoffUrl.build(target: target, mode: mode, fragment: try #require(entry["fragment"] as? Bool), params: params)
            let expectUrl = try #require(entry["expect_url"] as? String)
            #expect(url == expectUrl, "\(entry["name"]!)")
            #expect(url.contains("&dk=") && url.contains("&dts=") && url.contains("&dsig="))
        }
    }

    @Test func redirectsAreAllowedOnlyForTheirOwnBuild() throws {
        let fixture = Fixtures.proto("fixtures/uri/handoff-redirect.json")
        let configured = try #require(fixture["configured"] as? [String])
        let domain = URL(string: configured[0])!.host!
        func expect(_ redirect: String, _ build: String) -> Bool? {
            Fixtures.cases(fixture).first { $0["redirect"] as? String == redirect && $0["build"] as? String == build }?["expect"] as? Bool
        }
        let release = HandoffUrl.redirect(.https(domain: domain)), dev = HandoffUrl.redirect(.dev)
        #expect(expect(release, "release") == true)
        #expect(expect(dev, "dev") == true)
        #expect(expect(release, "dev") == false)
        #expect(expect(dev, "release") == false)
    }

    @Test func deviceLabelCases() throws {
        let fixture = Fixtures.plugin("device-labels.json")
        let fallback = try #require(fixture["fallback"] as? String)
        #expect(DeviceLabel.fallback == fallback)
        for entry in Fixtures.cases(fixture) {
            let model = try #require(entry["model"] as? String), want = try #require(entry["expect"] as? String)
            #expect(DeviceLabel.clean(name: entry["name_in"] as? String, model: model) == want, "\(entry["name"]!)")
        }
    }

    @Test func uaTokenBuildCases() throws {
        for entry in Fixtures.cases(Fixtures.proto("fixtures/ua/ua.json"), "build") {
            let input = try #require(entry["input"] as? [String: String])
            let token = UaToken.token(version: input["version"]!, os: UaToken.Os(rawValue: input["os"]!)!, form: UaToken.Form(rawValue: input["form"]!)!)
            #expect(token == entry["token"] as? String)
        }
        #expect(UaToken.token(version: "1.0", os: .ios, form: .phone) == nil)
    }

    @Test func messagesMatchTheSharedTable() throws {
        let fixture = Fixtures.plugin("messages.json")
        let signIn = try #require(fixture["sign_in"] as? [String: [String: Any]])
        #expect(Set(signIn.keys) == Set(Messages.signIn.keys))
        for (key, row) in signIn {
            let want = Messages.Row(message: try #require(row["message"] as? String), actions: [try #require(row["action"] as? String)])
            #expect(Messages.signIn[key] == want, "\(key)")
        }
        let overlay = try #require(fixture["overlay"] as? [String: [String: Any]])
        #expect(Set(overlay.keys) == Set(Messages.overlay.keys))
        for (key, row) in overlay {
            let want = Messages.Row(message: try #require(row["message"] as? String), actions: try #require(row["actions"] as? [String]))
            #expect(Messages.overlay[key] == want, "\(key)")
        }
        let allKinds: [SignInOutcome] = [.cancelled, .declined, .interrupted, .verificationFailed(domain: "d"), .rateLimited,
            .protocolUnsupported(min: nil, max: nil), .clockSkewed(serverTime: nil), .deviceKeyRejected(code: "c", securityLevel: .software),
            .refused(code: "c"), .noBrowser, .mismatch, .decryptFailed(code: "c"), .envelopeExpired, .notOwner(email: nil), .offline,
            .tlsError, .vaultLocked]
        for outcome in allKinds { #expect(Messages.signIn[outcome.kind] != nil, "\(outcome.kind)") }
        #expect(Messages.fill("{email} isn't the owner of {machine}.", ["email": "a@b.c", "machine": "m"]) == "a@b.c isn't the owner of m.")
    }

    @Test func b64urlIsStrict() {
        #expect(B64url.decode("AQ") == Data([1]))
        #expect(B64url.decode("AR") == nil)
        #expect(B64url.decode("AQ==") == nil)
        #expect(B64url.decode("A") == nil)
        #expect(B64url.decode("+/") == nil)
        #expect(B64url.encode(Data([0xfb, 0xff])) == "-_8")
    }
}
