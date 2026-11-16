/**
 * The relay-held FCM transport (G5 fallback, channel `fcm_relay`): subscribe by minting a relay
 * endpoint for the org's own keys, and open the relay's FCM data messages.
 *
 * `subscribe` reuses the stored subscription while it is bound to the same VAPID key, relay key
 * id and FCM token, else mints fresh keys and a new endpoint (02 `FcmMintRequest`). `open` reads
 * 02's `{v: "1", r, y}`, selects the org by `r` and decrypts `y` with Tink's RFC 8291
 * `WebPushHybridDecrypt`, which the UnifiedPush connector already bundles.
 *
 * - Trust boundary: the data message is attacker-reachable; any failure yields the generic text.
 * - Compiled into every build but reached only when `yaran.playPushTransport=relay-fcm`, which
 *   is the only build that sets `PushBindings.fcmToken`.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.relay.RelayFcmTransport
 * ├── io.github.siavz.yaran.push.DeviceRegistrar
 * ├── io.github.siavz.yaran.push.PushPayloadParser
 * ├── io.github.siavz.yaran.push.SubscriptionStore
 * ├── io.github.siavz.yaran.push.relay.FcmRelayKeyStore (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayEndpointClient (inferred)
 * External: com.google.crypto.tink.apps.fixed_webpush
 *
 * Used by:
 * io.github.siavz.yaran.push.relay.RelayFcmTransport
 * ├── io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * └── io.github.siavz.yaran.push.relay.RelayFcmTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.relay

import com.google.crypto.tink.apps.fixed_webpush.WebPushHybridDecrypt
import io.github.siavz.yaran.push.PushPayload
import io.github.siavz.yaran.push.PushPayloadParser
import io.github.siavz.yaran.push.SubscribeResult
import io.github.siavz.yaran.push.Subscription
import io.github.siavz.yaran.push.SubscriptionSource
import io.github.siavz.yaran.push.SubscriptionStore

class RelayFcmTransport(
    private val keys: FcmRelayKeyStore,
    private val subscriptions: SubscriptionStore,
    private val relay: RelayEndpointClient?,
    private val fcmToken: () -> String?,
) : SubscriptionSource {
    override fun subscribe(orgId: String, vapidPublicKey: String): SubscribeResult {
        val relay = relay ?: return SubscribeResult.Unavailable("this build has no push relay address")
        val token = fcmToken() ?: return SubscribeResult.Unavailable("Google Play services gave no FCM token")
        val kid = try {
            relay.endpointKeyId("fcm")
        } catch (e: RelayError) {
            return result(e)
        }
        val stored = subscriptions.load(orgId)
        if (stored != null && stored.vapidPublicKey == vapidPublicKey && stored.relayKeyId == kid && stored.transportTag == tokenTag(token)) {
            return SubscribeResult.Ok(stored)
        }
        val fresh = keys.create(orgId)
        val endpoint = try {
            relay.mint(relay.fcmMintBody(token, vapidPublicKey, fresh.registrationId))
        } catch (e: RelayError) {
            return result(e)
        }
        val subscription = Subscription(
            endpoint = endpoint, p256dh = FcmRelayKeyStore.b64(fresh.publicKey), auth = FcmRelayKeyStore.b64(fresh.auth),
            channel = "fcm_relay", distributor = null, vapidPublicKey = vapidPublicKey, relayKeyId = kid,
            transportTag = tokenTag(token),
        )
        subscriptions.save(orgId, subscription)
        return SubscribeResult.Ok(subscription)
    }

    override fun forget(orgId: String) {
        keys.delete(orgId)
    }

    /** One FCM data message: the org it belongs to and its payload (null: show the generic text). */
    fun open(data: Map<String, String>): Pair<String, PushPayload?>? {
        if (data["v"] != "1") return null
        val r = data["r"]?.takeIf { UUID.matches(it) } ?: return null
        val y = data["y"]?.takeIf { it.isNotEmpty() && B64URL.matches(it) } ?: return null
        val k = keys.find(r) ?: return null
        val payload = runCatching {
            val body = FcmRelayKeyStore.unb64(y)
            val plain = WebPushHybridDecrypt.Builder()
                .withAuthSecret(k.auth)
                .withRecipientPublicKey(k.publicKey)
                .withRecipientPrivateKey(k.privateKey)
                .build()
                .decrypt(body, null)
            PushPayloadParser.parse(plain)
        }.getOrNull()
        return k.orgId to payload
    }

    private fun result(e: RelayError): SubscribeResult = when (e) {
        is RelayError.Api -> SubscribeResult.Failed(e.message.orEmpty())
        RelayError.InsecureBaseUrl, RelayError.NotYaranRelay, RelayError.AppNotServed, RelayError.ChannelNotServed,
        is RelayError.RateLimited, is RelayError.Unavailable, RelayError.Malformed, RelayError.Network,
        -> SubscribeResult.Unavailable(e.message.orEmpty())
    }

    companion object {
        private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
        private val B64URL = Regex("[A-Za-z0-9_-]+")

        /** A short, non-reversible tag of the FCM token, so a token change forces a re-mint. */
        fun tokenTag(token: String): String =
            FcmRelayKeyStore.b64(java.security.MessageDigest.getInstance("SHA-256").digest(token.toByteArray())).take(16)
    }
}
