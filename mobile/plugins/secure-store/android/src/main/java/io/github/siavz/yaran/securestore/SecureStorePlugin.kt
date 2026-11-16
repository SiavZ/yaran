/**
 * SecureStorePlugin: the `SecureStore` bridge object, a thin adapter over the core `Vault`.
 *
 * Exposes get/set/remove/list on namespaced string values and the "erase everything on this
 * phone" action. Arguments go through [Validation]; core errors become their stable codes.
 *
 * - Runs on Capacitor's plugin thread; the vault serialises its own file access.
 * - [rejectWith] is the one error mapping every adapter in this package uses.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.SecureStorePlugin
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.core.Vault
 * └── io.github.siavz.yaran.securestore.Validation (inferred)
 * External: com.getcapacitor, com.getcapacitor.annotation, org.json
 *
 * Used by: entry point (Capacitor plugin class, listed in capacitor.plugins.json by the Capacitor CLI sync)
 * io.github.siavz.yaran.securestore.SecureStorePlugin
 * ├── io.github.siavz.yaran.securestore.AppLockPlugin (inferred)
 * ├── io.github.siavz.yaran.securestore.BuildInfoPlugin (inferred)
 * ├── io.github.siavz.yaran.securestore.DiagnosticsPlugin (inferred)
 * └── io.github.siavz.yaran.securestore.ScreenPrivacyPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.siavz.yaran.core.AppLock
import io.github.siavz.yaran.core.CoreError
import io.github.siavz.yaran.core.Vault
import org.json.JSONObject

@CapacitorPlugin(name = "SecureStore")
class SecureStorePlugin : Plugin() {
    private val vault by lazy { Vault.shared(context) }

    @PluginMethod
    fun get(call: PluginCall) =
        call.guarded {
            val value = vault.get(Validation.namespace(call.getString("namespace")), Validation.key(call.getString("key")))
            call.resolve(JSObject().put("value", value ?: JSONObject.NULL))
        }

    @PluginMethod
    fun set(call: PluginCall) =
        call.guarded {
            val namespace = Validation.namespace(call.getString("namespace"))
            val key = Validation.key(call.getString("key"))
            vault.set(namespace, key, Validation.value(call.getString("value")), Validation.protection(call.getString("protection")))
            call.resolve()
        }

    @PluginMethod
    fun remove(call: PluginCall) =
        call.guarded {
            vault.remove(Validation.namespace(call.getString("namespace")), Validation.key(call.getString("key")))
            call.resolve()
        }

    @PluginMethod
    fun list(call: PluginCall) =
        call.guarded {
            call.resolve(JSObject().put("keys", JSArray(vault.list(Validation.namespace(call.getString("namespace"))))))
        }

    @PluginMethod
    fun eraseAll(call: PluginCall) =
        call.guarded {
            vault.eraseAll()
            AppLock.shared(context).onVaultErased()
            call.resolve()
        }
}

/** Runs [block], rejecting the call with a stable code when it throws. */
internal inline fun PluginCall.guarded(block: () -> Unit) {
    try {
        block()
    } catch (e: ArgumentError) {
        reject(e.message, e.code)
    } catch (e: CoreError) {
        reject(e.message, e.code, e)
    }
}

/** Rejects with the stable code of [error]; anything unexpected is `unavailable`. */
internal fun PluginCall.rejectWith(error: Throwable) =
    when (error) {
        is ArgumentError -> reject(error.message, error.code)
        is CoreError -> reject(error.message, error.code, error)
        else -> reject(error.message ?: "unexpected native failure", "unavailable", error as? Exception)
    }
