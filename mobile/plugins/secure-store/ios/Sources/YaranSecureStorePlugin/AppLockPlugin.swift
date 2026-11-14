/// AppLockPlugin: the `AppLock` bridge object over the native app lock.
///
/// Forwards status, enable, disable, unlock and setOptions to `AppLock.shared` after argument
/// validation, and re-emits the core's lock notifications as the `lockStateChanged` event.
/// Unlocking reads the guarded Keychain item, so the biometric prompt comes from the Keychain;
/// Capacitor runs these calls off the main thread, which that blocking read needs.
///
/// - Outcomes are the TS contract's strings; failures reject with stable codes.
///
/// <module-headers:begin>
/// Uses:
/// YaranSecureStorePlugin/AppLockPlugin
/// ├── YaranCore/AppLock (inferred)
/// └── YaranCore/PluginArguments (inferred)
/// External: Capacitor, Foundation
///
/// Used by: none
/// <module-headers:end>

import Capacitor
import Foundation
import YaranCore

@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOptions", returnType: CAPPluginReturnPromise),
    ]
    private var observer: NSObjectProtocol?

    override public func load() {
        AppLock.shared.prompt = NSLocalizedString("lock.prompt", bundle: .main, value: "Unlock yaran", comment: "Keychain prompt")
        observer = NotificationCenter.default.addObserver(
            forName: AppLock.lockStateChanged, object: nil, queue: nil
        ) { [weak self] note in
            self?.notifyListeners("lockStateChanged", data: ["locked": note.userInfo?["locked"] as? Bool ?? false])
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func status(_ call: CAPPluginCall) {
        call.run {
            let status = AppLock.shared.status()
            return [
                "enabled": status.enabled,
                "allowPasscode": status.allowPasscode,
                "grace": status.grace.rawValue,
                "locked": status.locked,
                "biometry": status.biometry.rawValue,
            ]
        }
    }

    @objc func enable(_ call: CAPPluginCall) {
        call.run {
            let allowPasscode = try PluginArguments.flag(call.getBool("allowPasscode"))
            return ["outcome": try AppLock.shared.enable(allowPasscode: allowPasscode).rawValue]
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        call.run { ["outcome": try AppLock.shared.disable().rawValue] }
    }

    @objc func unlock(_ call: CAPPluginCall) {
        call.run { ["outcome": try AppLock.shared.unlock().rawValue] }
    }

    @objc func setOptions(_ call: CAPPluginCall) {
        call.run {
            let grace = try PluginArguments.grace(call.getString("grace"))
            try AppLock.shared.setOptions(grace: grace, allowPasscode: call.getBool("allowPasscode"))
            return nil
        }
    }
}
