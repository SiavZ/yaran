/**
 * Each org's current Web Push subscription as the Worker must receive it: endpoint, `p256dh`,
 * `auth`, channel, distributor and the VAPID key it was made with.
 *
 * The private key stays in the connector's Keystore-wrapped `DefaultKeyManager` (or
 * `FcmRelayKeyStore` on the relay-fcm path); this store holds only what W12 and `localState` need.
 *
 * - The endpoint is a capability and never leaves native code (D22); `localState` reads only
 *   its host.
 * - shortcut: plain no-backup `SharedPreferences`; move to Phase 14's Vault push namespace
 *   once it lands, since the endpoint is a capability.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content, android.net, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.SubscriptionStore
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * ├── io.github.siavz.yaran.push.UnifiedPushRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * ├── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * ├── io.github.siavz.yaran.push.relay.RelayFcmTest
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.content.Context
import android.net.Uri
import org.json.JSONObject

data class Subscription(
    val endpoint: String,
    val p256dh: String,
    val auth: String,
    /** 02 `PushChannel`: `unifiedpush`, `fcm_embedded` or `fcm_relay`. */
    val channel: String,
    val distributor: String?,
    val vapidPublicKey: String,
    /** Relay channels only: the relay `endpoint_key_id` it was minted under. */
    val relayKeyId: String? = null,
    /** Relay channels only: a hash tag of the FCM token it was minted for. */
    val transportTag: String? = null,
) {
    val endpointHost: String? get() = Uri.parse(endpoint).host?.lowercase()
}

class SubscriptionStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(orgId: String): Subscription? {
        val raw = prefs.getString(orgId, null) ?: return null
        val o = JSONObject(raw)
        return Subscription(
            endpoint = o.getString("endpoint"),
            p256dh = o.getString("p256dh"),
            auth = o.getString("auth"),
            channel = o.getString("channel"),
            distributor = o.optString("distributor").ifEmpty { null },
            vapidPublicKey = o.getString("vapid"),
            relayKeyId = o.optString("kid").ifEmpty { null },
            transportTag = o.optString("tag").ifEmpty { null },
        )
    }

    fun save(orgId: String, s: Subscription) {
        val o = JSONObject()
            .put("endpoint", s.endpoint).put("p256dh", s.p256dh).put("auth", s.auth)
            .put("channel", s.channel).put("distributor", s.distributor.orEmpty())
            .put("vapid", s.vapidPublicKey).put("kid", s.relayKeyId.orEmpty())
            .put("tag", s.transportTag.orEmpty())
        prefs.edit().putString(orgId, o.toString()).commit()
    }

    fun delete(orgId: String) {
        prefs.edit().remove(orgId).commit()
    }

    fun orgIds(): Set<String> = prefs.all.keys.toSet()

    companion object {
        const val PREFS = "yaran_push_subscriptions"
    }
}
