/// Fixture tests for the pure policy twins: navigation, control URLs, routes, renewal, refusals.
///
/// Every case of `fixtures/navigation-cases.json`, `routes.json`, `renewal-cases.json`,
/// `refusal-cases.json`, and of the protocol's `uri/control-urls.json` and
/// `registry/refusals.json`, is asserted by name, so a twin that drifts fails here.
///
/// - Pure; no I/O beyond reading the fixtures.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/PolicyTests
/// ├── MachineViewCore/ControlUrl (inferred)
/// ├── MachineViewCore/NavigationPolicy (inferred)
/// ├── MachineViewCore/RefusalPolicy (inferred)
/// ├── MachineViewCore/RenewalPolicy (inferred)
/// ├── MachineViewCore/RouteFragment (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct PolicyTests {
    @Test func navigationCases() {
        let fx = Fixtures.plugin("navigation-cases.json")
        let host = fx["host"] as! String
        let cases = Fixtures.cases(fx)
        #expect(cases.count >= 60)
        for c in cases {
            let v = NavigationPolicy.decide(pinnedHost: host, url: c["url"] as! String, mainFrame: c["frame"] as! String == "main",
                                            newWindow: c["new_window"] as! Bool, gesture: c["gesture"] as! Bool)
            #expect(v.decision.rawValue == c["expect"] as! String, "\(c["name"]!)")
            #expect(v.diagnostic == c["diagnostic"] as! Bool, "\(c["name"]!)")
        }
    }

    @Test func controlUrlCases() {
        for c in Fixtures.cases(Fixtures.proto("fixtures/uri/control-urls.json")) {
            let d = ControlUrl.decision(c["uri"] as! String, loadedHost: c["loaded_host"] as! String)
            let name: String
            var code: String?
            switch d {
            case .reauth: name = "reauth"
            case .home: name = "home"
            case .settings: name = "settings"
            case .ignore(let c): name = "ignore"; code = c
            }
            #expect(name == c["expect"] as! String, "\(c["uri"]!)")
            #expect(code == c["code"] as? String, "\(c["uri"]!)")
        }
    }

    @Test func routeCases() {
        for c in Fixtures.cases(Fixtures.plugin("routes.json")) {
            #expect(RouteFragment.isValid(c["route"] as! String) == c["expect"] as! Bool, "\(c["route"]!)")
        }
    }

    @Test func renewalCases() {
        let fx = Fixtures.plugin("renewal-cases.json")
        let k = fx["constants"] as! [String: Any]
        #expect(RenewalPolicy.preOpenMaxS == k["pre_open_max_s"] as! Int64)
        #expect(RenewalPolicy.preOpenDivisor == k["pre_open_divisor"] as! Int64)
        #expect(RenewalPolicy.bannerS == k["banner_s"] as! Int64)
        for c in Fixtures.cases(fx) {
            let d = RenewalPolicy.decide(now: c["now"] as! Int64, iat: c["iat"] as? Int64, exp: c["exp"] as! Int64,
                                         context: RenewalContext(rawValue: c["context"] as! String)!, visible: c["visible"] as! Bool)
            let e = c["expect"] as! [String: Any]
            #expect(d.action.rawValue == e["action"] as! String, "\(c["name"]!)")
            #expect(d.nextCheckAt == e["next_check_at"] as? Int64, "\(c["name"]!)")
        }
    }

    @Test func refusalCases() {
        for c in Fixtures.cases(Fixtures.plugin("refusal-cases.json")) {
            let v = RefusalPolicy.decide(status: c["status"] as! Int, refusal: c["refusal"] as? String)
            let e = c["expect"] as! [String: Any]
            #expect(v.decision.rawValue == e["decision"] as! String, "\(c["name"]!)")
            #expect(v.diagnostic == e["diagnostic"] as! Bool, "\(c["name"]!)")
        }
    }

    @Test func everyRegistryRefusalHasADecision() {
        let registry = Fixtures.proto("registry/refusals.json")["refusals"] as! [[String: Any]]
        #expect(Set(registry.map { $0["code"] as! String }) == RefusalPolicy.known)
        for r in registry {
            let v = RefusalPolicy.decide(status: r["status"] as! Int, refusal: r["code"] as? String)
            #expect(!v.diagnostic && v.decision != .none && v.decision != .codeOverlay, "\(r["code"]!)")
        }
    }
}
