/**
 * Capacitor adapter for `MachineView` (`src/definitions.ts`): open (org, direct and routes
 * forms), close, the held share (G5) and the `closed` and `shareReceived` events.
 *
 * Validates the arguments (hosts, ids, instance, the agent route) and starts
 * [MachineViewActivity]; `share: true` moves the held files into that intent as `ClipData`
 * with a read grant, so the grant belongs to the window and outlives the shell activity. The
 * window reports back through [emit], with the host context of [closedEvent]. No logic beyond validation lives here.
 *
 * - Main thread (Capacitor plugin calls).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineViewPlugin
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * └── io.github.siavz.yaran.machineview.ShareHolder (inferred)
 * External: android.content, com.getcapacitor, com.getcapacitor.annotation, java.lang.ref, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineViewPlugin
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.ShareBatchRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.ShareHolder (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.ClipData
import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

@CapacitorPlugin(name = "MachineView")
class MachineViewPlugin : Plugin() {
    override fun load() {
        instance = WeakReference(this)
        ShareHolder.flush(runCatching { PluginRuntime.get(context).core.appLock.isLocked() }.getOrDefault(true))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val route = call.getString("route")
        val s = when (val kind = call.getString("kind") ?: "org") {
            "org" -> MachineState.of(call.getString("orgId"), call.getString("machineId"), call.getString("host"), route)
            "direct" -> MachineState.parse(kind, JSONArray().put(JSONObject().put("kind", "direct").put("host", call.getString("host"))).toString(),
                call.getString("instance"), route)
            "routes" -> MachineState.parse(kind, call.getArray("routes")?.toString(), call.getString("instance"), route)
            else -> null
        } ?: return call.reject("the open options are invalid", "invalid_arguments")
        val intent = Intent(context, MachineViewActivity::class.java)
            .putExtra(MachineState.K_KIND, s.kind.wire)
            .putExtra(MachineState.K_ROUTES, MachineState.routesJson(s.routes))
            .putExtra(MachineState.K_ROUTE, route)
        s.instance?.let { intent.putExtra(MachineState.K_INSTANCE, it) }
        // `share: true` was replaced by `shareBatch`: never let an old call succeed without its files.
        if (call.data.has("share")) return call.reject("share is replaced by shareBatch", "invalid_arguments")
        val shareBatch = call.getString("shareBatch")
        if (call.data.has("shareBatch") && !ShareHolder.validBatch(shareBatch)) return call.reject("shareBatch is malformed", "invalid_arguments")
        if (shareBatch != null) {
            val uris = when (val claim = ShareHolder.take(shareBatch)) {
                is ShareHolder.Claim.Taken -> claim.uris
                ShareHolder.Claim.Changed -> return call.reject("another share replaced it", "share_changed")
                ShareHolder.Claim.None -> return call.reject("no shared files are held", "no_share")
            }
            val clip = ClipData.newRawUri(null, uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
            intent.clipData = clip
            intent.putExtra(MachineViewActivity.K_SHARE, true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
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

    @PluginMethod
    fun shareStatus(call: PluginCall) {
        val (n, batch) = ShareHolder.status()
        call.resolve(if (batch == null) JSObject().put("kind", "none") else JSObject().put("kind", "pending").put("count", n).put("batch", batch))
    }

    /** Forgets the held share only if it is the one named: the user's Discard acts on the share it showed. */
    @PluginMethod
    fun discardShare(call: PluginCall) {
        val batch = call.getString("batch")
        if (!ShareHolder.validBatch(batch)) return call.reject("batch is missing or malformed", "invalid_arguments")
        when (ShareHolder.discard(batch!!)) {
            ShareHolder.Claim.Changed -> call.reject("another share replaced it", "share_changed")
            is ShareHolder.Claim.Taken, ShareHolder.Claim.None -> call.resolve()
        }
    }

    companion object {
        @Volatile private var instance: WeakReference<MachineViewPlugin>? = null

        /**
         * `ClosedEvent`: the host the window was on (the one rejected, for `instance_changed`)
         * and the host its open named, so the shell attributes a late close to the right
         * machine. Host names only; absent fields are left out for older listeners.
         */
        internal fun closedEvent(reason: String, code: String?, host: String?, requestedHost: String?): Map<String, Any?> =
            linkedMapOf<String, Any?>("reason" to reason).apply {
                code?.let { put("code", it) }
                host?.let { put("host", it) }
                requestedHost?.let { put("requestedHost", it) }
            }

        internal fun emit(closed: Map<String, Any?>) {
            instance?.get()?.notifyListeners("closed", SessionPlugin.js(closed), true)
        }

        /** False while no bridge has loaded this plugin yet: the holder keeps the event. */
        internal fun emitShare(e: ShareEvent): Boolean {
            val p = instance?.get() ?: return false
            p.notifyListeners("shareReceived", SessionPlugin.js(e.toJs()), true)
            return true
        }
    }
}
