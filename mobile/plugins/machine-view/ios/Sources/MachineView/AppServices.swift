/// The composition root of the iOS plugin: one set of stores and clients shared by both plugins.
///
/// Built on first use from the seams Phase 14's AppDelegate installed (`CoreBindings.install`),
/// the build's callback mode (`YaranPublisherDomain` in Info.plist; empty or absent means a
/// development build), the UA token and the device label.
///
/// - Main actor. Not compiled on this machine (UIKit); see the plugin README in the report.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/AppServices
/// ├── MachineView/AuthSessionLauncher (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/DataStores (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/DeviceLabel (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SecureEnclaveBackend (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// └── MachineViewCore/UaToken (inferred)
/// External: Foundation, UIKit
///
/// Used by:
/// MachineView/AppServices
/// ├── MachineView/MachineViewController (inferred)
/// └── MachineView/SessionPlugin (inferred)
/// <module-headers:end>
import Foundation
import MachineViewCore
import UIKit

@MainActor
final class AppServices {
    static let shared = AppServices()

    let diagnostics: DiagnosticsSink?
    let orgs: OrgDirectory
    let installs: InstallIdStore
    let deviceKeys: DeviceKeyStore
    let sessions: SessionStore
    let cleaner: WebDataCleaner
    let api: OrgApiClient
    let launcher: AuthSessionLauncher
    let handoff: HandoffClient
    let mode: CallbackMode
    let uaToken: String

    private init() {
        let vault = CoreBindings.vault
        diagnostics = CoreBindings.diagnostics
        orgs = CoreBindings.orgs ?? NoOrgs()
        let appLock = CoreBindings.appLock
        installs = InstallIdStore(vault: vault)
        deviceKeys = DeviceKeyStore(backend: SecureEnclaveBackend(), installs: installs, diagnostics: diagnostics)
        sessions = SessionStore(vault: vault, diagnostics: diagnostics, lockEnabled: { appLock?.lockEnabled() ?? false })
        cleaner = WebKitDataCleaner(diagnostics: diagnostics)
        mode = Self.callbackMode()
        uaToken = Self.makeUaToken()
        api = OrgApiClient(orgs: orgs, sessions: sessions, installs: installs, deviceKeys: deviceKeys, userAgent: uaToken,
                           cleaner: cleaner, diagnostics: diagnostics, clock: Self.now)
        launcher = AuthSessionLauncher()
        let device = UIDevice.current
        handoff = HandoffClient(vault: vault, deviceKeys: deviceKeys, sessions: sessions, orgs: orgs, launcher: launcher,
                                mode: mode, deviceLabel: DeviceLabel.clean(name: device.name, model: device.model),
                                clock: Self.now, diagnostics: diagnostics)
    }

    nonisolated static func now() -> Int64 { Int64(Date().timeIntervalSince1970) }

    nonisolated static func callbackMode() -> CallbackMode {
        let domain = (Bundle.main.object(forInfoDictionaryKey: "YaranPublisherDomain") as? String) ?? ""
        return Pattern.hostname.matches(domain) ? .https(domain: domain) : .dev
    }

    static func makeUaToken() -> String {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
        let form: UaToken.Form = UIDevice.current.userInterfaceIdiom == .pad ? .tablet : .phone
        // A malformed bundle version still yields a parseable token rather than none at all.
        return UaToken.token(version: version, os: .ios, form: form) ?? "YaranApp/0.0.0 (ios; \(form.rawValue))"
    }
}

private final class NoOrgs: OrgDirectory {
    func orgUrl(_ orgId: String) -> String? { nil }
}
