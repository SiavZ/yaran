/**
 * Capacitor adapter for `MachineView` (`src/definitions.ts`): open, close, and the closed event.
 *
 * Validates the arguments (host, ids, the agent route) and starts [MachineViewActivity];
 * the window reports back through [emitClosed]. No logic beyond validation lives here.
 *
 * - Main thread (Capacitor plugin calls).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineViewPlugin
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * External: android.content, com.getcapacitor, com.getcapacitor.annotation, java.lang.ref
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineViewPlugin
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "MachineView")
class MachineViewPlugin : Plugin() {
    override fun load() {
        instance = WeakReference(this)
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val s = MachineState.of(call.getString("orgId"), call.getString("machineId"), call.getString("host"), call.getString("route"))
            ?: return call.reject("orgId, machineId, host or route is invalid", "invalid_arguments")
        val intent = Intent(context, MachineViewActivity::class.java)
            .putExtra(MachineState.K_ORG, s.orgId)
            .putExtra(MachineState.K_MACHINE, s.machineId)
            .putExtra(MachineState.K_HOST, s.host)
            .putExtra(MachineState.K_ROUTE, call.getString("route"))
        activity.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun close(call: PluginCall) {
        activity.runOnUiThread {
            MachineViewActivity.current?.get()?.close("user", null)
            call.resolve()
        }
    }

    companion object {
        @Volatile private var instance: WeakReference<MachineViewPlugin>? = null

        internal fun emitClosed(reason: String, code: String?) {
            val event = JSObject().put("reason", reason)
            code?.let { event.put("code", it) }
            instance?.get()?.notifyListeners("closed", event, true)
        }
    }
}
