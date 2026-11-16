/**
 * AppLockPlugin: the `AppLock` bridge object, a thin adapter over the core `AppLock`.
 *
 * Status, enable, disable, unlock and options; the biometric prompt and every decision live
 * in the core. Lock-state changes are forwarded to the shell as `lockStateChanged` events.
 *
 * - Outcomes resolve with the `definitions.ts` strings; failures reject with stable codes.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.AppLockPlugin
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.securestore.SecureStorePlugin (inferred)
 * └── io.github.siavz.yaran.securestore.Validation (inferred)
 * External: com.getcapacitor, com.getcapacitor.annotation
 *
 * Used by: entry point (Capacitor plugin class, listed in capacitor.plugins.json by the Capacitor CLI sync)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.siavz.yaran.core.AppLock

@CapacitorPlugin(name = "AppLock")
class AppLockPlugin : Plugin() {
    private val appLock by lazy { AppLock.shared(context) }
    private val forward: (Boolean) -> Unit = { locked -> notifyListeners("lockStateChanged", JSObject().put("locked", locked)) }

    override fun load() {
        appLock.addListener(forward)
    }

    override fun handleOnDestroy() {
        appLock.removeListener(forward)
    }

    @PluginMethod
    fun status(call: PluginCall) =
        call.guarded {
            val status = appLock.status()
            call.resolve(
                JSObject()
                    .put("enabled", status.enabled)
                    .put("allowPasscode", status.allowPasscode)
                    .put("grace", status.grace.code)
                    .put("locked", status.locked)
                    .put("biometry", status.biometry.code),
            )
        }

    @PluginMethod
    fun enable(call: PluginCall) =
        call.guarded {
            appLock.enable(activity, Validation.flag(call.getBoolean("allowPasscode"), "allowPasscode")) { result ->
                result.fold({ call.resolve(JSObject().put("outcome", it.code)) }, call::rejectWith)
            }
        }

    @PluginMethod
    fun disable(call: PluginCall) =
        call.guarded {
            appLock.disable(activity) { result -> result.fold({ call.resolve(JSObject().put("outcome", it.code)) }, call::rejectWith) }
        }

    @PluginMethod
    fun unlock(call: PluginCall) =
        call.guarded {
            appLock.unlock(activity) { result -> result.fold({ call.resolve(JSObject().put("outcome", it.code)) }, call::rejectWith) }
        }

    @PluginMethod
    fun setOptions(call: PluginCall) =
        call.guarded {
            appLock.setOptions(Validation.grace(call.getString("grace")), call.getBoolean("allowPasscode", null))
            call.resolve()
        }
}
