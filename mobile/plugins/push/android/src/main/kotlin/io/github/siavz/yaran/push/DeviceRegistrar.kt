/**
 * `Push.registerDevice` on Android: obtain the org's subscription from the build's transport,
 * build 02's `DeviceRegistration` with `push` and `device_key` filled natively, and send W12
 * through Phase 15's org client.
 *
 * Push off sends `push: {kind: "none"}` with the same device key and drops the local
 * subscription; it never deletes the device (a revoked device would cost the whole org).
 *
 * - D22: the outcome carries only the Worker's `Device` (which never echoes the endpoint) or a
 *   reason; the endpoint and keys stay in native code.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.DeviceRegistrar
 * ├── io.github.siavz.yaran.push.PushBindings (inferred)
 * └── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * External: org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.DeviceRegistrar
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * ├── io.github.siavz.yaran.push.UnifiedPushRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * ├── io.github.siavz.yaran.push.relay.RelayFcmTest
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import org.json.JSONArray
import org.json.JSONObject

data class RegisterRequest(
    val orgId: String,
    val installId: String,
    val label: String,
    val locale: String?,
    /** The bridge's `PushMutes` object, as the Worker's record holds it. */
    val mutes: JSONObject,
    val pushOff: Boolean,
    val vapidPublicKey: String?,
)

/** What a transport answers for one org's subscription. */
sealed class SubscribeResult {
    data class Ok(val subscription: Subscription) : SubscribeResult()
    object NoDistributor : SubscribeResult()
    data class Unavailable(val reason: String) : SubscribeResult()
    data class Failed(val reason: String) : SubscribeResult()
}

/** UnifiedPush (foss and the embedded FCM distributor) or relay-held FCM. */
interface SubscriptionSource {
    fun subscribe(orgId: String, vapidPublicKey: String): SubscribeResult
    fun forget(orgId: String)
}

sealed class RegisterOutcome {
    data class Ok(val device: JSONObject) : RegisterOutcome()
    data class Api(val result: OrgApiResult) : RegisterOutcome()
    object NoDistributor : RegisterOutcome()
    data class PushUnavailable(val reason: String) : RegisterOutcome()
    data class RegistrationFailed(val reason: String) : RegisterOutcome()
}

class DeviceRegistrar(
    private val gateway: OrgApiGateway,
    private val source: SubscriptionSource,
    private val subscriptions: SubscriptionStore,
    private val app: AppInfo,
    private val formFactor: String,
) {
    fun register(request: RegisterRequest): RegisterOutcome {
        val deviceKey = runCatching { gateway.devicePublicKey(request.orgId) }.getOrNull()
            ?: return RegisterOutcome.RegistrationFailed("the device key for this organization is unavailable")
        val push = if (request.pushOff) {
            source.forget(request.orgId)
            subscriptions.delete(request.orgId)
            JSONObject().put("kind", "none")
        } else {
            val vapid = request.vapidPublicKey ?: return RegisterOutcome.PushUnavailable("push is turned off for this organization")
            when (val r = source.subscribe(request.orgId, vapid)) {
                is SubscribeResult.Ok -> webpush(r.subscription)
                SubscribeResult.NoDistributor -> return RegisterOutcome.NoDistributor
                is SubscribeResult.Unavailable -> return RegisterOutcome.PushUnavailable(r.reason)
                is SubscribeResult.Failed -> return RegisterOutcome.RegistrationFailed(r.reason)
            }
        }
        val body = registrationBody(request, deviceKey, push) ?: return RegisterOutcome.RegistrationFailed("the mute settings are not valid")
        return when (val result = gateway.registerDevice(request.orgId, body)) {
            is OrgApiResult.Ok -> runCatching { RegisterOutcome.Ok(JSONObject(result.body)) }
                .getOrElse { RegisterOutcome.RegistrationFailed("the organization sent an unreadable device record") }
            OrgApiResult.DeviceRevoked -> {
                source.forget(request.orgId)
                subscriptions.delete(request.orgId)
                RegisterOutcome.Api(result)
            }
            is OrgApiResult.ApiError, OrgApiResult.SessionExpired, OrgApiResult.Offline, OrgApiResult.TlsError,
            OrgApiResult.Refused, OrgApiResult.ProtocolUnsupported -> RegisterOutcome.Api(result)
        }
    }

    private fun webpush(s: Subscription): JSONObject = JSONObject()
        .put("kind", "webpush")
        .put("channel", s.channel)
        .put("endpoint", s.endpoint)
        .put("keys", JSONObject().put("p256dh", s.p256dh).put("auth", s.auth))
        .apply { s.distributor?.take(128)?.let { put("distributor", it) } }

    /** 02 `DeviceRegistration`, exactly its fields; null when the mutes are off-shape. */
    fun registrationBody(request: RegisterRequest, deviceKey: String, push: JSONObject): JSONObject? {
        val ids = request.mutes.optJSONArray("muted_machine_ids") ?: JSONArray()
        if (ids.length() > 100) return null
        val until = request.mutes.opt("muted_until")
        if (until != null && until != JSONObject.NULL && until !is String) return null
        return JSONObject()
            .put("install_id", request.installId)
            .put("device_key", deviceKey)
            .put("platform", "android")
            .put("flavor", app.flavor)
            .put("form_factor", formFactor)
            .put("app_version", app.appVersion)
            .put("label", request.label.take(64))
            .put("push", push)
            .put("mute_all", request.mutes.optBoolean("mute_all", false))
            .put("muted_until", until ?: JSONObject.NULL)
            .put("muted_machine_ids", ids)
            .apply { request.locale?.let { put("locale", it) } }
    }
}
