/// PluginArgumentsTests: the adapters' argument validation and error-code mapping.
///
/// The Capacitor plugin target cannot compile on a Mac, so the rules it delegates to are
/// pinned here: namespace and key shapes, reserved namespaces, enum arguments, and the
/// mapping of every core error onto the TS contract's codes.
///
/// - Also covers the ScreenPrivacy cover rule and the Diagnostics caps.
///
/// <module-headers:begin>
/// Uses:
/// YaranCoreTests/PluginArgumentsTests
/// ├── YaranCore/Diagnostics (inferred)
/// ├── YaranCore/KeychainStore (inferred)
/// ├── YaranCore/PluginArguments (inferred)
/// ├── YaranCore/ScreenPrivacy (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Foundation, Testing
///
/// Used by: none
/// <module-headers:end>

import Foundation
import Testing
@testable import YaranCore

struct PluginArgumentsTests {
    @Test(arguments: ["session", "handoff", "install", "push", "push-keys", "sessions"])
    func reservedNamespacesAreRefused(_ name: String) {
        #expect(throws: PluginErrorCode.reservedNamespace) { try PluginArguments.namespace(name) }
    }

    @Test(arguments: [nil, "", "Orgs", "a_b", String(repeating: "a", count: 33)] as [String?])
    func malformedNamespacesAreInvalid(_ name: String?) {
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.namespace(name) }
    }

    @Test func validArgumentsPass() throws {
        #expect(try PluginArguments.namespace("orgs-2") == "orgs-2")
        #expect(try PluginArguments.key("A.b_c-1") == "A.b_c-1")
        #expect(try PluginArguments.protection(nil) == .standard)
        #expect(try PluginArguments.protection("locked") == .locked)
        #expect(try PluginArguments.grace("5min") == .fiveMinutes)
        #expect(try PluginArguments.grace(nil) == nil)
        #expect(try PluginArguments.level("warn") == .warn)
        #expect(try PluginArguments.value("") == "")
    }

    @Test func malformedValuesAreInvalid() {
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.key(String(repeating: "k", count: 65)) }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.key("a b") }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.value(nil) }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.protection("secret") }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.grace("2min") }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.level("debug") }
        #expect(throws: PluginErrorCode.invalidArgument) { try PluginArguments.flag(nil) }
    }

    @Test func coreErrorsMapToStableCodes() {
        #expect(PluginArguments.code(for: VaultError.tampered) == .tampered)
        #expect(PluginArguments.code(for: VaultError.invalidated) == .invalidated)
        #expect(PluginArguments.code(for: VaultError.locked) == .locked)
        #expect(PluginArguments.code(for: VaultError.unavailable) == .unavailable)
        #expect(PluginArguments.code(for: VaultError.invalidArgument) == .invalidArgument)
        #expect(PluginArguments.code(for: KeychainFailure.cancelled) == .unavailable)
        #expect(Set(PluginErrorCode.allCases.map(\.rawValue)) ==
            ["invalid_argument", "reserved_namespace", "tampered", "invalidated", "locked", "unavailable"])
    }

    @Test func coverRule() {
        #expect(ScreenPrivacy.shouldCover(enabled: false, inactive: true, captured: true, locked: true))
        #expect(!ScreenPrivacy.shouldCover(enabled: false, inactive: true, captured: true, locked: false))
        #expect(ScreenPrivacy.shouldCover(enabled: true, inactive: true, captured: false, locked: false))
        #expect(ScreenPrivacy.shouldCover(enabled: true, inactive: false, captured: true, locked: false))
        #expect(!ScreenPrivacy.shouldCover(enabled: true, inactive: false, captured: false, locked: false))
    }

    @Test func diagnosticsSanitizesAndCaps() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).log")
        defer { try? FileManager.default.removeItem(at: file) }
        var clock: Int64 = 0
        let log = Diagnostics(fileURL: file, now: { clock })
        log.append(level: .info, message: "GET https://a.example.com/x?t=secret")
        #expect(log.read().hasSuffix("info GET https://a.example.com/x"))
        clock = Diagnostics.maxAgeMs + 1
        log.append(level: .warn, message: "later\nline")
        #expect(log.read().components(separatedBy: "\n").count == 1)
        #expect(log.read().hasSuffix("warn later\\nline"))
        let big = String(repeating: "x", count: 600_000)
        log.append(level: .error, message: big)
        log.append(level: .error, message: big)
        let onDisk = try String(contentsOf: file, encoding: .utf8)
        #expect(onDisk.utf8.count <= Diagnostics.maxBytes)
        #expect(Diagnostics(fileURL: file, now: { clock }).read() == log.read())
    }
}
