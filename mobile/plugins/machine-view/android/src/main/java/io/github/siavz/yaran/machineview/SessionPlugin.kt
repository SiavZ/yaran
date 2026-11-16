/**
 * Capacitor adapter for `Session` (`src/definitions.ts`): sign-in, status and the org API client.
 *
 * Each method validates its arguments, runs the native work on the runtime's io executor and
 * resolves with the exhaustive result maps. No method returns a JWT, a cookie or a key (D22);
 * the device key's public point and the install id are identifiers, not credentials.
 *
 * - The Auth Tab launcher is registered in [load], during BridgeActivity.onCreate.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SessionPlugin
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: com.getcapacitor, com.getcapacitor.annotation, org.json
 *
 * Used by: entry point (Capacitor plugin (@CapacitorPlugin), registered by the app's Capacitor bridge)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject

@CapacitorPlugin(name = "Session")
class SessionPlugin : Plugin() {
    private lateinit var launcher: BrowserLauncher

    override fun load() {
        launcher = BrowserLauncher(activity)
    }

    /** Back from a Custom Tab with no redirect (the user closed it): cancelled after the grace. */
    override fun handleOnResume() {
        if (SignInFlow.inFlight()) SignInFlow.onCancelSoon(activity)
    }

    private fun rt() = PluginRuntime.get(context)

    private fun background(call: PluginCall, work: (PluginRuntime) -> JSObject?) {
        val rt = try {
            rt()
        } catch (e: IllegalStateException) {
            return call.reject("the app has not installed its core bindings", "unavailable")
        }
        rt.io.execute {
            try {
                work(rt)?.let { call.resolve(it) } ?: call.resolve()
            } catch (e: VaultLockedException) {
                call.reject("the vault is locked", "vault_locked")
            }
        }
    }

    @PluginMethod
    fun meta(call: PluginCall) {
        val orgUrl = call.getString("orgUrl") ?: return call.reject("orgUrl is required", "invalid_arguments")
        background(call) { toJs(it.orgApi.meta(orgUrl)) }
    }

    @PluginMethod
    fun signIn(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_arguments")
        val target = when (val t = call.data.opt("target")) {
            "control-plane" -> SignInTarget.ControlPlane
            is JSONObject -> t.optString("machineHost").takeIf { it.isNotEmpty() }?.let { SignInTarget.Machine(it) }
            else -> null
        } ?: return call.reject("target must be \"control-plane\" or {machineHost}", "invalid_arguments")
        activity.runOnUiThread { SignInFlow.start(activity, launcher, orgId, target) { call.resolve(JSObject.fromJSONObject(JSONObject(it.toJs()))) } }
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val host = call.getString("host") ?: return call.reject("host is required", "invalid_arguments")
        background(call) { rt ->
            val s = rt.sessions.status(host, System.currentTimeMillis() / 1000)
            JSObject().put("signedIn", s != null).apply { s?.let { put("expiresAt", it.exp) } }
        }
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val orgId = call.getString("orgId")
        val method = call.getString("method")
        val path = call.getString("path")
        if (orgId == null || method == null || path == null) return call.reject("orgId, method and path are required", "invalid_arguments")
        val body = call.data.opt("body")?.takeIf { it != JSONObject.NULL }
        background(call) { toJs(it.orgApi.request(orgId, method, path, body)) }
    }

    @PluginMethod
    fun installId(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_arguments")
        background(call) { JSObject().put("installId", it.deviceKeys.ensure(orgId).installId) }
    }

    @PluginMethod
    fun deviceKey(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_arguments")
        background(call) { JSObject().put("deviceKey", it.deviceKeys.ensure(orgId).publicKey) }
    }

    @PluginMethod
    fun callbackMode(call: PluginCall) {
        background(call) { rt ->
            when (val m = rt.mode) {
                is CallbackMode.Https -> JSObject().put("mode", "https").put("domain", m.domain)
                CallbackMode.Dev -> JSObject().put("mode", "dev")
            }
        }
    }

    @PluginMethod
    fun signOut(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_arguments")
        val hosts = call.getArray("hosts", JSArray())!!.toList<Any>().map { it.toString() }.filter { HostRules.HOSTNAME.matches(it) }
        background(call) { rt ->
            rt.wipeOrg(orgId, hosts)
            null
        }
    }

    companion object {
        internal fun toJs(r: ApiResult): JSObject {
            val o = JSObject().put("kind", r.kind)
            when (r) {
                is ApiResult.Ok -> o.put("status", r.status).put("body", r.bodyJson?.let { JSONObject("{\"b\":$it}").get("b") } ?: JSONObject.NULL)
                is ApiResult.ApiError -> o.put("status", r.status).put("error", JSONObject(r.envelopeJson))
                is ApiResult.Refused -> o.put("reason", r.reason)
                is ApiResult.ProtocolUnsupported -> { r.min?.let { o.put("min", it) }; r.max?.let { o.put("max", it) } }
                ApiResult.SessionExpired, ApiResult.DeviceRevoked, ApiResult.Offline, ApiResult.TlsError -> Unit
            }
            return o
        }
    }
}
