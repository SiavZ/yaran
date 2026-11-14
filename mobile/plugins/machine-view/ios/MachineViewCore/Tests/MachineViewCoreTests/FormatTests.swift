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
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct FormatTests {
    @Test func cookieCases() {
        let fx = Fixtures.plugin("cookie-cases.json")
        #expect(CookieSpec.clearCookies == fx["clear"] as! [String])
        for c in Fixtures.cases(fx) {
            let e = c["expect"] as! [String: Any]
            let kind = CredentialKind(rawValue: c["credential_kind"] as! String)!
            do {
                let r = try CookieSpec.make(kind: kind, jwt: c["jwt"] as! String, cookie: c["cookie"] as? String)
                #expect(r.setCookie == e["set_cookie"] as? String, "\(c["name"]!)")
                #expect(r.used.rawValue == e["used"] as? String, "\(c["name"]!)")
                #expect(r.diagnostic == e["diagnostic"] as? Bool, "\(c["name"]!)")
            } catch {
                #expect(e["error"] as? String == "invalid_value" && error as? CookieSpecError == .invalidValue, "\(c["name"]!)")
            }
        }
        #expect(throws: CookieSpecError.notACookieCredential) { try CookieSpec.make(kind: .managedOAuth, jwt: "a.b.c", cookie: nil) }
        #expect(CookieSpec.cookieUrl(host: "h.example.com") == "https://h.example.com/")
    }

    @Test func callbackCases() {
        let fx = Fixtures.plugin("callback-cases.json")
        #expect(CallbackUrl.ttlS == fx["ttl_s"] as! Int64)
        for c in Fixtures.cases(fx) {
            let mode: CallbackMode = c["mode"] as! String == "dev" ? .dev : .https(domain: c["domain"] as! String)
            let pending = (c["pending"] as? [String: Any]).map {
                PendingState(state: $0["state"] as! String, createdAt: $0["created_at"] as! Int64)
            }
            let r = CallbackUrl.parse(mode: mode, uri: c["uri"] as! String, pending: pending, now: c["now"] as! Int64)
            let e = c["expect"] as! [String: Any]
            let expected: CallbackResult
            switch e["result"] as! String {
            case "success": expected = .success(jwe: e["jwe"] as! String)
            case "error":
                expected = .error(code: e["code"] as! String, min: e["min"] as? Int, max: e["max"] as? Int,
                                  serverTime: e["server_time"] as? Int64)
            default: expected = .refused(CallbackRefusal(rawValue: e["reason"] as! String)!)
            }
            #expect(r == expected, "\(c["name"]!)")
        }
    }

    @Test func handoffUrlCases() {
        for c in Fixtures.cases(Fixtures.plugin("handoff-url-cases.json")) {
            let p = c["params"] as! [String: Any]
            let target: HandoffTarget = c["target"] as! String == "machine"
                ? .machine(host: c["host"] as! String) : .controlPlane(orgUrl: c["org_url"] as! String)
            let mode: CallbackMode = c["mode"] as! String == "dev" ? .dev : .https(domain: c["domain"] as! String)
            let params = HandoffParams(pk: p["pk"] as! String, state: p["state"] as! String, device: c["device"] as! String,
                                       dk: p["dk"] as! String, dts: Int64(p["dts"] as! String)!, dsig: p["dsig"] as! String)
            let url = HandoffUrl.build(target: target, mode: mode, fragment: c["fragment"] as! Bool, params: params)
            #expect(url == c["expect_url"] as! String, "\(c["name"]!)")
            #expect(url.contains("&dk=") && url.contains("&dts=") && url.contains("&dsig="))
        }
    }

    @Test func redirectsAreAllowedOnlyForTheirOwnBuild() {
        let fx = Fixtures.proto("fixtures/uri/handoff-redirect.json")
        let configured = fx["configured"] as! [String]
        let domain = URL(string: configured[0])!.host!
        func expect(_ redirect: String, _ build: String) -> Bool? {
            Fixtures.cases(fx).first { $0["redirect"] as? String == redirect && $0["build"] as? String == build }?["expect"] as? Bool
        }
        let release = HandoffUrl.redirect(.https(domain: domain)), dev = HandoffUrl.redirect(.dev)
        #expect(expect(release, "release") == true)
        #expect(expect(dev, "dev") == true)
        #expect(expect(release, "dev") == false)
        #expect(expect(dev, "release") == false)
    }

    @Test func deviceLabelCases() {
        let fx = Fixtures.plugin("device-labels.json")
        #expect(DeviceLabel.fallback == fx["fallback"] as! String)
        for c in Fixtures.cases(fx) {
            #expect(DeviceLabel.clean(name: c["name_in"] as? String, model: c["model"] as! String) == c["expect"] as! String,
                    "\(c["name"]!)")
        }
    }

    @Test func uaTokenBuildCases() {
        for c in Fixtures.cases(Fixtures.proto("fixtures/ua/ua.json"), "build") {
            let i = c["input"] as! [String: String]
            let t = UaToken.token(version: i["version"]!, os: UaToken.Os(rawValue: i["os"]!)!, form: UaToken.Form(rawValue: i["form"]!)!)
            #expect(t == c["token"] as? String)
        }
        #expect(UaToken.token(version: "1.0", os: .ios, form: .phone) == nil)
    }

    @Test func messagesMatchTheSharedTable() {
        let fx = Fixtures.plugin("messages.json")
        let signIn = fx["sign_in"] as! [String: [String: Any]]
        #expect(Set(signIn.keys) == Set(Messages.signIn.keys))
        for (k, v) in signIn {
            #expect(Messages.signIn[k] == Messages.Row(message: v["message"] as! String, actions: [v["action"] as! String]), "\(k)")
        }
        let overlay = fx["overlay"] as! [String: [String: Any]]
        #expect(Set(overlay.keys) == Set(Messages.overlay.keys))
        for (k, v) in overlay {
            #expect(Messages.overlay[k] == Messages.Row(message: v["message"] as! String, actions: v["actions"] as! [String]), "\(k)")
        }
        let allKinds: [SignInOutcome] = [.cancelled, .declined, .interrupted, .verificationFailed(domain: "d"), .rateLimited,
            .protocolUnsupported(min: nil, max: nil), .clockSkewed(serverTime: nil), .deviceKeyRejected(code: "c", securityLevel: .software),
            .refused(code: "c"), .noBrowser, .mismatch, .decryptFailed(code: "c"), .envelopeExpired, .notOwner(email: nil), .offline,
            .tlsError, .vaultLocked]
        for o in allKinds { #expect(Messages.signIn[o.kind] != nil, "\(o.kind)") }
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
