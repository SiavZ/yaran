/// Test helper: loads the shared fixtures both native suites read.
///
/// Paths resolve from this file (`#filePath`), so `swift test` reads the committed bytes of
/// `mobile/plugins/machine-view/fixtures/` and `cloud/protocol/` with no copying.
///
/// - Test-only; aborts the test on a missing or unparsable fixture.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCoreTests/Fixtures
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

enum Fixtures {
    static let pluginRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    static let repoRoot = pluginRoot.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    /// `fixtures/<name>` of this plugin.
    static func plugin(_ name: String) -> [String: Any] { load(pluginRoot.appendingPathComponent("fixtures/\(name)")) }

    /// `cloud/protocol/<path>`.
    static func proto(_ path: String) -> [String: Any] { load(repoRoot.appendingPathComponent("cloud/protocol/\(path)")) }

    static func protoDir(_ dir: String) -> [(String, [String: Any])] {
        let url = repoRoot.appendingPathComponent("cloud/protocol/\(dir)")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: url.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }.sorted().map { ($0, load(url.appendingPathComponent($0))) }
    }

    static func load(_ url: URL) -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            fatalError("fixture missing or not a JSON object: \(url.path)")
        }
        return obj
    }

    static func cases(_ obj: [String: Any], _ key: String = "cases") -> [[String: Any]] {
        obj[key] as? [[String: Any]] ?? []
    }
}

extension Data {
    init(hex: String) {
        var out = Data()
        var it = hex.makeIterator()
        while let a = it.next(), let b = it.next() { out.append(UInt8(String([a, b]), radix: 16)!) }
        self = out
    }

    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
