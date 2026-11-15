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
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// └── MachineViewCoreTests/FormatTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct PolicyTests {
    @Test func navigationCases() throws {
        let fixture = Fixtures.plugin("navigation-cases.json")
        let host = try #require(fixture["host"] as? String)
        let cases = Fixtures.cases(fixture)
        #expect(cases.count >= 60)
        for entry in cases {
            let verdict = NavigationPolicy.decide(pinnedHost: host, url: try #require(entry["url"] as? String),
                                                  mainFrame: try #require(entry["frame"] as? String) == "main",
                                                  newWindow: try #require(entry["new_window"] as? Bool), gesture: try #require(entry["gesture"] as? Bool))
            #expect(verdict.decision.rawValue == entry["expect"] as? String, "\(entry["name"]!)")
            #expect(verdict.diagnostic == entry["diagnostic"] as? Bool, "\(entry["name"]!)")
        }
    }

    @Test func controlUrlCases() throws {
        for entry in Fixtures.cases(Fixtures.proto("fixtures/uri/control-urls.json")) {
            let decision = ControlUrl.decision(try #require(entry["uri"] as? String), loadedHost: try #require(entry["loaded_host"] as? String))
            let name: String
            var code: String?
            switch decision {
            case .reauth: name = "reauth"
            case .home: name = "home"
            case .settings: name = "settings"
            case .ignore(let ignoreCode): name = "ignore"; code = ignoreCode
            }
            #expect(name == entry["expect"] as? String, "\(entry["uri"]!)")
            #expect(code == entry["code"] as? String, "\(entry["uri"]!)")
        }
    }

    @Test func routeCases() throws {
        for entry in Fixtures.cases(Fixtures.plugin("routes.json")) {
            #expect(RouteFragment.isValid(try #require(entry["route"] as? String)) == entry["expect"] as? Bool, "\(entry["route"]!)")
        }
    }

    @Test func renewalCases() throws {
        let fixture = Fixtures.plugin("renewal-cases.json")
        let constants = try #require(fixture["constants"] as? [String: Any])
        #expect(RenewalPolicy.preOpenMaxS == constants["pre_open_max_s"] as? Int64)
        #expect(RenewalPolicy.preOpenDivisor == constants["pre_open_divisor"] as? Int64)
        #expect(RenewalPolicy.bannerS == constants["banner_s"] as? Int64)
        for entry in Fixtures.cases(fixture) {
            let context = try #require((entry["context"] as? String).flatMap(RenewalContext.init(rawValue:)))
            let decision = RenewalPolicy.decide(now: try #require(entry["now"] as? Int64), iat: entry["iat"] as? Int64, exp: try #require(entry["exp"] as? Int64),
                                                context: context, visible: try #require(entry["visible"] as? Bool))
            let want = try #require(entry["expect"] as? [String: Any])
            #expect(decision.action.rawValue == want["action"] as? String, "\(entry["name"]!)")
            #expect(decision.nextCheckAt == want["next_check_at"] as? Int64, "\(entry["name"]!)")
        }
    }

    @Test func refusalCases() throws {
        for entry in Fixtures.cases(Fixtures.plugin("refusal-cases.json")) {
            let verdict = RefusalPolicy.decide(status: try #require(entry["status"] as? Int), refusal: entry["refusal"] as? String)
            let want = try #require(entry["expect"] as? [String: Any])
            #expect(verdict.decision.rawValue == want["decision"] as? String, "\(entry["name"]!)")
            #expect(verdict.diagnostic == want["diagnostic"] as? Bool, "\(entry["name"]!)")
        }
    }

    @Test func everyRegistryRefusalHasADecision() throws {
        let registry = try #require(Fixtures.proto("registry/refusals.json")["refusals"] as? [[String: Any]])
        let codes = try registry.map { try #require($0["code"] as? String) }
        #expect(Set(codes) == RefusalPolicy.known)
        for refusal in registry {
            let verdict = RefusalPolicy.decide(status: try #require(refusal["status"] as? Int), refusal: refusal["code"] as? String)
            #expect(!verdict.diagnostic && verdict.decision != .none && verdict.decision != .codeOverlay, "\(refusal["code"]!)")
        }
    }
}
