/// FixtureTests: runs the Sanitizer and HostRules against every case of the shared fixtures.
///
/// The same JSON files drive the Kotlin core suite and the shell, so a rule change that is not
/// made on every platform fails here first. Any mismatch fails with the case's input.
///
/// - Fixtures are found relative to this file (`mobile/plugins/core/fixtures`).
///
/// <module-headers:begin>
/// Uses:
/// YaranCoreTests/FixtureTests
/// ├── YaranCore/HostRules (inferred)
/// └── YaranCore/Sanitizer (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash mobile/plugins/core/ios/test.sh)
/// YaranCoreTests/FixtureTests
/// └── YaranCoreTests/VaultTests (inferred)
/// <module-headers:end>

import Foundation
import Testing
@testable import YaranCore

private let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("../../../fixtures")
    .standardizedFileURL

private func load(_ name: String) throws -> [String: Any] {
    let data = try Data(contentsOf: fixtures.appendingPathComponent(name))
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

private func expected(_ expect: [String: String]) -> HostRulesResult? {
    if let ok = expect["ok"] { return .ok(ok) }
    return expect["refused"].flatMap(HostRefusal.init(rawValue:)).map { .refused($0) }
}

struct FixtureTests {
    @Test func sanitizerMatchesEveryFixtureCase() throws {
        let cases = try #require(try load("sanitizer-cases.json")["cases"] as? [[String: String]])
        #expect(!cases.isEmpty)
        for item in cases {
            let input = try #require(item["input"])
            #expect(Sanitizer.sanitize(input) == item["expect"], "\(item["name"] ?? input)")
        }
    }

    @Test func hostRulesMatchEveryFixtureCase() throws {
        let root = try load("host-rules-cases.json")
        let suites: [(String, (String) -> HostRulesResult)] = [("orgUrl", HostRules.orgUrl), ("host", HostRules.host)]
        for (name, rule) in suites {
            let cases = try #require(root[name] as? [[String: Any]])
            #expect(!cases.isEmpty)
            for item in cases {
                let input = try #require(item["input"] as? String)
                let raw = try #require(item["expect"] as? [String: String])
                let expect = try #require(expected(raw), "bad fixture \(input)")
                #expect(rule(input) == expect, "\(name)(\(input.debugDescription))")
            }
        }
    }
}
