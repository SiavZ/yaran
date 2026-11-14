/// SecureStorePlugin: the `SecureStore` bridge object over the native Vault.
///
/// Validates every argument through `PluginArguments` (namespaces reserved for native code are
/// refused with `reserved_namespace`) and forwards to `Vault.shared`; it holds no logic of its
/// own. `eraseAll` also resets the app lock and clears the diagnostics log.
///
/// - Values are strings the shell owns (JSON text); `get` resolves `null` for a missing key.
///
/// <module-headers:begin>
/// Uses:
/// YaranSecureStorePlugin/SecureStorePlugin
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/Diagnostics (inferred)
/// ├── YaranCore/PluginArguments (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Capacitor, Foundation
///
/// Used by: entry point (Capacitor bridge class, listed in packageClassList by the Capacitor CLI sync)
/// <module-headers:end>

import Capacitor
import Foundation
import YaranCore

@objc(SecureStorePlugin)
public class SecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureStorePlugin"
    public let jsName = "SecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "eraseAll", returnType: CAPPluginReturnPromise),
    ]

    @objc func get(_ call: CAPPluginCall) {
        call.run {
            let namespace = try PluginArguments.namespace(call.getString("namespace"))
            let key = try PluginArguments.key(call.getString("key"))
            let value = try Vault.shared.get(namespace: namespace, key: key)
            return ["value": value ?? NSNull()]
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        call.run {
            let namespace = try PluginArguments.namespace(call.getString("namespace"))
            let key = try PluginArguments.key(call.getString("key"))
            let value = try PluginArguments.value(call.getString("value"))
            let protection = try PluginArguments.protection(call.getString("protection"))
            try Vault.shared.set(namespace: namespace, key: key, value: value, protection: protection)
            return nil
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        call.run {
            let namespace = try PluginArguments.namespace(call.getString("namespace"))
            let key = try PluginArguments.key(call.getString("key"))
            try Vault.shared.remove(namespace: namespace, key: key)
            return nil
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        call.run {
            let namespace = try PluginArguments.namespace(call.getString("namespace"))
            return ["keys": try Vault.shared.list(namespace: namespace)]
        }
    }

    @objc func eraseAll(_ call: CAPPluginCall) {
        call.run {
            try Vault.shared.eraseAll()
            AppLock.shared.reset()
            Diagnostics.shared.clear()
            return nil
        }
    }
}
