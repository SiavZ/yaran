/**
 * `Push` Capacitor plugin, Android: the bridge between the shell's push orchestration and the
 * native transports, stores and presenter.
 *
 * Validates arguments, runs registration on its own executor (a distributor answer can take
 * seconds), and returns only non-secret facts: a `Device`, a reason, or the local state's host
 * and key id. The `notifications` permission alias wraps `POST_NOTIFICATIONS` (Android 13+); a
 * notification tap arrives as an intent and is emitted retained, so a cold-start tap waits for
 * the shell's listener.
 *
 * - D22: no endpoint, key, auth secret or credential crosses the bridge in either direction.
 * - The app binds `PushBindings` (Phase 15's org client, build info) before plugins load.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.MuteStore (inferred)
 * ├── io.github.siavz.yaran.push.NotificationActionActivity (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.PendingRegistrationStore (inferred)
 * ├── io.github.siavz.yaran.push.PushBindings (inferred)
 * ├── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * ├── io.github.siavz.yaran.push.UnifiedPushRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.relay.FcmRelayKeyStore
 * ├── io.github.siavz.yaran.push.relay.RelayEndpointClient
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport
 * External: android, android.content, android.os, android.provider, androidx.core.app, com.getcapacitor, com.getcapacitor.annotation, java.lang.ref, java.util.concurrent, org.json
 *
 * Used by: entry point (Capacitor plugin class (@CapacitorPlugin name Push), registered by the Capacitor CLI)
 * io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * └── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import io.github.siavz.yaran.push.relay.FcmRelayKeyStore
import io.github.siavz.yaran.push.relay.RelayEndpointClient
import io.github.siavz.yaran.push.relay.RelayFcmTransport
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.Executors

@CapacitorPlugin(
    name = "Push",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class PushPlugin : Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    private val subscriptions by lazy { SubscriptionStore(context) }
    private val mutes by lazy { MuteStore(context) }
    private val presenter by lazy { NotificationPresenter(context, mutes) }
    private val unifiedPush by lazy { UnifiedPushRegistrar(context, subscriptions) }
    private val relayKeys by lazy { FcmRelayKeyStore(context) }

    private fun relayClient(app: AppInfo): RelayEndpointClient? =
        app.relayBaseUrl?.let { runCatching { RelayEndpointClient(it, app.applicationId) }.getOrNull() }

    private fun source(app: AppInfo): SubscriptionSource = when (app.transport) {
        PushTransport.UNIFIED_PUSH -> unifiedPush
        PushTransport.RELAY_FCM -> RelayFcmTransport(relayKeys, subscriptions, relayClient(app)) { PushBindings.fcmToken?.invoke() }
    }

    override fun load() {
        instance = WeakReference(this)
        presenter.ensureChannels()
        activity?.intent?.let(::emitTap)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        emitTap(intent)
    }

    private fun emitTap(intent: Intent) {
        val action = intent.getStringExtra(NotificationPresenter.EXTRA_TAP_ACTION) ?: return
        val data = JSObject()
            .put("action", if (action == NotificationPresenter.ACTION_MUTE_MACHINE) "mute_machine" else "open")
        intent.getStringExtra(NotificationPresenter.EXTRA_ORG)?.let { data.put("orgId", it) }
        intent.getStringExtra(NotificationPresenter.EXTRA_MACHINE)?.let { data.put("machineId", it) }
        intent.getStringExtra(NotificationPresenter.EXTRA_AGENT)?.let { data.put("agentId", it) }
        intent.getStringExtra(NotificationPresenter.EXTRA_TAB)?.let { data.put("tabId", it) }
        NotificationActionActivity.FORWARDED.forEach(intent::removeExtra)
        notifyListeners("notificationTapped", data, true)
    }

    private fun permissionState(): String = when {
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ->
            if (NotificationManagerCompat.from(context).areNotificationsEnabled()) "granted" else "denied"
        else -> when (getPermissionState("notifications")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            PermissionState.PROMPT -> "prompt"
            PermissionState.PROMPT_WITH_RATIONALE -> "prompt-with-rationale"
            null -> "prompt"
        }
    }

    @PluginMethod
    fun checkPermission(call: PluginCall) {
        call.resolve(JSObject().put("notifications", permissionState()))
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || permissionState() == "granted") return checkPermission(call)
        requestPermissionForAlias("notifications", call, "permissionAnswered")
    }

    @PermissionCallback
    private fun permissionAnswered(call: PluginCall) = checkPermission(call)

    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun listDistributors(call: PluginCall) {
        call.resolve(
            JSObject()
                .put("distributors", JSArray(unifiedPush.distributors()))
                .put("selected", unifiedPush.selected() ?: JSONObject.NULL)
                .put("embedded", unifiedPush.embedded() ?: JSONObject.NULL),
        )
    }

    @PluginMethod
    fun selectDistributor(call: PluginCall) {
        val distributor = call.getString("distributor")
        if (distributor == null || distributor !in unifiedPush.distributors()) return call.reject("unknown distributor", "invalid_argument")
        unifiedPush.select(distributor)
        call.resolve()
    }

    @PluginMethod
    fun registerDevice(call: PluginCall) {
        val gateway = PushBindings.orgApi
        val app = PushBindings.app
        val request = RegisterRequest(
            orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument"),
            installId = call.getString("installId") ?: return call.reject("installId is required", "invalid_argument"),
            label = call.getString("label") ?: return call.reject("label is required", "invalid_argument"),
            locale = call.getString("locale"),
            mutes = call.getObject("mutes") ?: JSObject(),
            pushOff = call.getBoolean("pushOff", false) == true,
            vapidPublicKey = call.getString("vapidPublicKey"),
        )
        if (gateway == null || app == null) return call.reject("the org client is not bound", "unavailable")
        if (!request.pushOff && permissionState() != "granted") return call.resolve(JSObject().put("outcome", "needs_permission"))
        executor.execute {
            val formFactor = if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
            val outcome = DeviceRegistrar(gateway, source(app), subscriptions, app, formFactor).register(request)
            if (outcome is RegisterOutcome.Ok) mutes.setMutes(request.orgId, LocalMutes.fromJson(request.mutes))
            call.resolve(outcomeJson(outcome))
        }
    }

    @PluginMethod
    fun localState(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument")
        executor.execute {
            val s = subscriptions.load(orgId)
            val current = if (s?.channel == "fcm_relay") {
                PushBindings.app?.let(::relayClient)?.let { runCatching { it.endpointKeyId("fcm") == s.relayKeyId }.getOrNull() }
            } else {
                null
            }
            call.resolve(
                JSObject()
                    .put("subscribed", s != null)
                    .put("channel", s?.channel ?: JSONObject.NULL)
                    .put("endpointHost", s?.endpointHost ?: JSONObject.NULL)
                    .put("vapidPublicKey", s?.vapidPublicKey ?: JSONObject.NULL)
                    .put("relayKeyId", s?.relayKeyId ?: JSONObject.NULL)
                    .put("relayKeyCurrent", current ?: JSONObject.NULL),
            )
        }
    }

    @PluginMethod
    fun forgetOrg(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument")
        executor.execute {
            unifiedPush.forget(orgId)
            relayKeys.delete(orgId)
            subscriptions.delete(orgId)
            mutes.forget(orgId)
            call.resolve()
        }
    }

    @PluginMethod
    fun setLocalMutes(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument")
        mutes.setMutes(orgId, LocalMutes.fromJson(call.getObject("mutes")))
        call.resolve()
    }

    @PluginMethod
    fun cacheMachineNames(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument")
        val orgName = call.getString("orgName") ?: return call.reject("orgName is required", "invalid_argument")
        val list = call.getArray("machines") ?: JSArray()
        val machines = (0 until list.length()).mapNotNull { list.optJSONObject(it) }
            .mapNotNull { m -> m.optString("id").ifEmpty { null }?.let { it to m.optString("name") } }.toMap()
        mutes.setDirectory(orgId, OrgDirectory(orgName, machines))
        call.resolve()
    }

    @PluginMethod
    fun setVisibleAgent(call: PluginCall) {
        val orgId = call.getString("orgId")
        val machineId = call.getString("machineId")
        val agentId = call.getString("agentId")
        if (orgId == null || machineId == null || agentId == null) {
            NotificationPresenter.visibleAgent = null
            return call.resolve()
        }
        NotificationPresenter.visibleAgent = VisibleAgent(orgId, machineId, agentId, call.getString("tabId"))
        presenter.cancelMatching(orgId, machineId, agentId, null, anyTab = true)
        call.resolve()
    }

    @PluginMethod
    fun clearDelivered(call: PluginCall) {
        val orgId = call.getString("orgId") ?: return call.reject("orgId is required", "invalid_argument")
        val machineId = call.getString("machineId") ?: return call.reject("machineId is required", "invalid_argument")
        val tabId = call.getString("tabId")
        presenter.cancelMatching(orgId, machineId, call.getString("agentId"), tabId, anyTab = tabId == null)
        call.resolve()
    }

    @PluginMethod
    fun drainPendingRegistrations(call: PluginCall) {
        call.resolve(JSObject().put("orgIds", JSArray(PendingRegistrationStore(context).drain().toList())))
    }

    companion object {
        @Volatile private var instance: WeakReference<PushPlugin>? = null

        /** Emits to a live shell; false when no bridge is running (the caller falls back). */
        fun emit(event: String, data: Map<String, String>): Boolean {
            val plugin = instance?.get() ?: return false
            plugin.notifyListeners(event, JSObject().apply { data.forEach { (k, v) -> put(k, v) } }, true)
            return true
        }

        fun outcomeJson(o: RegisterOutcome): JSObject = when (o) {
            is RegisterOutcome.Ok -> JSObject().put("outcome", "ok").put("device", o.device)
            RegisterOutcome.NoDistributor -> JSObject().put("outcome", "no_distributor")
            is RegisterOutcome.PushUnavailable -> JSObject().put("outcome", "push_unavailable").put("reason", o.reason)
            is RegisterOutcome.RegistrationFailed -> JSObject().put("outcome", "registration_failed").put("reason", o.reason)
            is RegisterOutcome.Api -> when (val r = o.result) {
                is OrgApiResult.Ok -> JSObject().put("outcome", "registration_failed").put("reason", "unexpected success shape")
                is OrgApiResult.ApiError -> JSObject().put("outcome", "api_error").put("status", r.status).put("code", r.code)
                OrgApiResult.SessionExpired -> JSObject().put("outcome", "session_expired")
                OrgApiResult.DeviceRevoked -> JSObject().put("outcome", "device_revoked")
                OrgApiResult.Offline -> JSObject().put("outcome", "offline")
                OrgApiResult.TlsError -> JSObject().put("outcome", "tls_error")
                OrgApiResult.Refused -> JSObject().put("outcome", "refused")
                OrgApiResult.ProtocolUnsupported -> JSObject().put("outcome", "protocol_unsupported")
            }
        }
    }
}
