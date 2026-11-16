/// PluginArguments: the argument and error rules every Capacitor adapter applies.
///
/// The bridge is a trust boundary, so each adapter turns raw call values into typed ones here
/// before touching the core, and maps any thrown error onto one of the stable codes of
/// `mobile/plugins/secure-store/src/definitions.ts`. Keeping this pure (no Capacitor) lets
/// `swift test` cover what the plugin target itself cannot compile on a Mac.
///
/// - Namespaces `session`, `handoff`, `install` and `push` (prefix match) belong to native code
///   and are refused with `reserved_namespace`.
/// - Missing or malformed values are `invalid_argument`.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/PluginArguments
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/Diagnostics (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Foundation
///
/// Used by:
/// YaranCore/PluginArguments
/// ├── YaranCoreTests/PluginArgumentsTests (inferred)
/// ├── YaranSecureStorePlugin/AppLockPlugin (inferred)
/// ├── YaranSecureStorePlugin/DiagnosticsPlugin (inferred)
/// ├── YaranSecureStorePlugin/PluginCallResult (inferred)
/// ├── YaranSecureStorePlugin/ScreenPrivacyPlugin (inferred)
/// └── YaranSecureStorePlugin/SecureStorePlugin (inferred)
/// <module-headers:end>

import Foundation

/// The stable rejection codes (`SecureStoreErrorCode` in the TS contract).
public enum PluginErrorCode: String, Error, Sendable, CaseIterable {
    case invalidArgument = "invalid_argument"
    case reservedNamespace = "reserved_namespace"
    case tampered, invalidated, locked, unavailable
}

public enum PluginArguments {
    public static let reservedNamespaces = ["session", "handoff", "install", "push"]

    /// A JS-reachable namespace: valid shape and not reserved for native code.
    public static func namespace(_ raw: String?) throws -> String {
        guard let raw, Vault.isValidNamespace(raw) else { throw PluginErrorCode.invalidArgument }
        if reservedNamespaces.contains(where: { raw.hasPrefix($0) }) { throw PluginErrorCode.reservedNamespace }
        return raw
    }

    public static func key(_ raw: String?) throws -> String {
        guard let raw, Vault.isValidKey(raw) else { throw PluginErrorCode.invalidArgument }
        return raw
    }

    public static func value(_ raw: String?) throws -> String {
        guard let raw else { throw PluginErrorCode.invalidArgument }
        return raw
    }

    /// Absent means `standard`.
    public static func protection(_ raw: String?) throws -> Protection {
        guard let raw else { return .standard }
        guard let protection = Protection(rawValue: raw) else { throw PluginErrorCode.invalidArgument }
        return protection
    }

    /// Absent means "leave unchanged".
    public static func grace(_ raw: String?) throws -> LockGrace? {
        guard let raw else { return nil }
        guard let grace = LockGrace(rawValue: raw) else { throw PluginErrorCode.invalidArgument }
        return grace
    }

    public static func level(_ raw: String?) throws -> DiagnosticsLevel {
        guard let raw, let level = DiagnosticsLevel(rawValue: raw) else { throw PluginErrorCode.invalidArgument }
        return level
    }

    public static func flag(_ raw: Bool?) throws -> Bool {
        guard let raw else { throw PluginErrorCode.invalidArgument }
        return raw
    }

    /// Maps anything the core throws onto a stable code; unknown errors are `unavailable`.
    public static func code(for error: Error) -> PluginErrorCode {
        switch error {
        case let code as PluginErrorCode: return code
        case let vault as VaultError: return code(for: vault)
        default: return .unavailable
        }
    }

    private static func code(for error: VaultError) -> PluginErrorCode {
        switch error {
        case .tampered: return .tampered
        case .invalidated: return .invalidated
        case .locked: return .locked
        case .unavailable: return .unavailable
        case .invalidArgument: return .invalidArgument
        }
    }
}
