/// ScreenPrivacyPlugin: the `ScreenPrivacy` bridge object over the native cover setting.
///
/// Persists the setting natively (so the next launch applies it before the shell loads) and
/// re-applies the cover rule at once on the main thread.
///
/// - The cover itself is `PrivacyCover` in the core, attached by the App's SceneDelegate.
///
/// <module-headers:begin>
/// Uses:
/// YaranSecureStorePlugin/ScreenPrivacyPlugin
/// ├── YaranCore/PluginArguments (inferred)
/// └── YaranCore/ScreenPrivacy (inferred)
/// External: Capacitor, Foundation
///
/// Used by: none
/// <module-headers:end>

import Capacitor
import Foundation
import YaranCore

@objc(ScreenPrivacyPlugin)
public class ScreenPrivacyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenPrivacyPlugin"
    public let jsName = "ScreenPrivacy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    @objc func set(_ call: CAPPluginCall) {
        call.run {
            ScreenPrivacy.isEnabled = try PluginArguments.flag(call.getBool("enabled"))
            DispatchQueue.main.async { PrivacyCover.shared.update() }
            return nil
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        call.run { ["enabled": ScreenPrivacy.isEnabled] }
    }
}
