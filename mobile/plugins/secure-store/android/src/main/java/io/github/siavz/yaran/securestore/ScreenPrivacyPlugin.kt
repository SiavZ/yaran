/**
 * ScreenPrivacyPlugin: the `ScreenPrivacy` bridge object over the core `ScreenPrivacy`.
 *
 * Reads and persists the setting; the core applies `FLAG_SECURE` to every app window.
 *
 * - [load] installs the core's activity callbacks too (idempotent), so the setting holds
 *   even in a host activity that did not install it itself.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.ScreenPrivacyPlugin
 * ├── io.github.siavz.yaran.core.ScreenPrivacy
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
import io.github.siavz.yaran.core.ScreenPrivacy

@CapacitorPlugin(name = "ScreenPrivacy")
class ScreenPrivacyPlugin : Plugin() {
    private val privacy by lazy { ScreenPrivacy.install(activity) }

    override fun load() {
        privacy
    }

    @PluginMethod
    fun set(call: PluginCall) =
        call.guarded {
            privacy.set(Validation.flag(call.getBoolean("enabled"), "enabled"))
            call.resolve()
        }

    @PluginMethod
    fun get(call: PluginCall) =
        call.guarded {
            call.resolve(JSObject().put("enabled", privacy.enabled))
        }
}
