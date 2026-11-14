/// The seams to Phase 14's native core (vault, diagnostics, org records, app lock, privacy).
///
/// This plugin codes against these protocols, so its tests use fakes; the app's AppDelegate
/// calls `CoreAdapters.installDefault()` at launch, which installs `plugins/core` behind them.
/// Uninstalled, every vault use fails closed (`VaultError.unavailable`), never silently.
///
/// - `Fallbacks` holds the gate-selected build switches (Phase 03 G1, G6, G13), one constant each.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/Seams
/// └── MachineViewCore/CookieSpec (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/Seams
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/CookieInjector (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/DataStores (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public enum ProtectionClass { case standard, locked }

public enum VaultError: Error, Equatable {
    /// The `locked` class needs App Lock to unlock first.
    case locked
    /// Phase 14's core was never installed.
    case unavailable
}

public protocol SecretVault: AnyObject {
    func read(_ ns: String) throws -> Data?
    func write(_ ns: String, _ value: Data, _ cls: ProtectionClass) throws
    func delete(_ ns: String) throws
    func list(prefix: String) throws -> [String]
}

/// Core sanitizes every line again; callers never pass a token, key or query string.
public protocol DiagnosticsSink: AnyObject { func append(_ line: String) }

public protocol OrgDirectory: AnyObject { func orgUrl(_ orgId: String) -> String? }

public protocol AppLockState: AnyObject {
    func lockEnabled() -> Bool
    func isLocked() -> Bool
}

public protocol ScreenPrivacyState: AnyObject { func enabled() -> Bool }

/// Clears what a WebView keeps for a host (cookies, the per-machine data store).
public protocol WebDataCleaner: AnyObject { func clear(hosts: [String]) }

public enum CoreBindings {
    public private(set) static var vault: SecretVault = UnavailableVault()
    public private(set) static var diagnostics: DiagnosticsSink?
    public private(set) static var orgs: OrgDirectory?
    public private(set) static var appLock: AppLockState?
    public private(set) static var screenPrivacy: ScreenPrivacyState?

    public static func install(vault: SecretVault, diagnostics: DiagnosticsSink, orgs: OrgDirectory,
                               appLock: AppLockState, screenPrivacy: ScreenPrivacyState) {
        (self.vault, self.diagnostics, self.orgs, self.appLock, self.screenPrivacy) =
            (vault, diagnostics, orgs, appLock, screenPrivacy)
    }
}

final class UnavailableVault: SecretVault {
    func read(_ ns: String) throws -> Data? { throw VaultError.unavailable }
    func write(_ ns: String, _ value: Data, _ cls: ProtectionClass) throws { throw VaultError.unavailable }
    func delete(_ ns: String) throws { throw VaultError.unavailable }
    func list(prefix: String) throws -> [String] { throw VaultError.unavailable }
}

/// Build-time switches selected by Phase 03 gate outcomes; flipping one is a constant change.
public enum Fallbacks {
    /// G1 step 1 flips this to `.accessCookie`.
    public static let credentialRung: CredentialKind = .accessJwt
    /// G13: send `mode=fragment` when a browser strips or logs the query on the App Link hop.
    public static let handoffModeFragment = false
    /// G6: when > 0, poll the cookie store up to this long before the first load.
    public static let cookiePollMs = 0
}

/// One sanitized-by-construction diagnostics line: `machine-view <event> k=v …`, values cut
/// at 64 characters and stripped of anything but `[A-Za-z0-9._:/-]`.
public func diagLine(_ event: String, _ fields: [(String, String)] = []) -> String {
    let safe = fields.map { key, value in
        "\(key)=" + String(value.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) && $0.isASCII || "._:/-".unicodeScalars.contains($0) }.prefix(64).map(Character.init))
    }
    return (["machine-view", event] + safe).joined(separator: " ")
}
