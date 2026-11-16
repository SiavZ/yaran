/**
 * BuildInfoPlugin: the `BuildInfo` bridge object, the compiled build facts the shell cannot know.
 *
 * One web bundle serves every flavor, so the flavor and the e2e defaults (Phase 19 hook H6)
 * come from `<meta-data>` the app module writes into its manifest per flavor and build type:
 * `io.github.siavz.yaran.FLAVOR`, `.E2E` and `.E2E_CONTROL_PLANE_URL`.
 *
 * - A library cannot read the app's `BuildConfig`, hence the manifest route.
 * - The control-plane URL is empty outside the `e2e` build type.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.BuildInfoPlugin
 * ├── io.github.siavz.yaran.core.Vault
 * └── io.github.siavz.yaran.securestore.SecureStorePlugin (inferred)
 * External: android.content.pm, com.getcapacitor, com.getcapacitor.annotation
 *
 * Used by: entry point (Capacitor plugin class, listed in capacitor.plugins.json by the Capacitor CLI sync)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import android.content.pm.PackageManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.siavz.yaran.core.CoreError

@CapacitorPlugin(name = "BuildInfo")
class BuildInfoPlugin : Plugin() {
    @PluginMethod
    fun get(call: PluginCall) =
        call.guarded {
            @Suppress("DEPRECATION")
            val meta = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
            val flavor = meta?.getString("$PREFIX.FLAVOR") ?: throw CoreError.Unavailable("the app manifest carries no flavor")
            call.resolve(
                JSObject()
                    .put("flavor", flavor)
                    .put("e2e", meta.getBoolean("$PREFIX.E2E", false))
                    .put("e2eControlPlaneUrl", meta.getString("$PREFIX.E2E_CONTROL_PLANE_URL").orEmpty()),
            )
        }

    private companion object {
        const val PREFIX = "io.github.siavz.yaran"
    }
}
