/**
 * G5 fallback receiver: FCM data messages from the publisher relay, compiled only into `play`
 * builds with `yaran.playPushTransport=relay-fcm`.
 *
 * Hands 02's `{v: "1", r, y}` to the plugin's `RelayFcmTransport`, which selects the org by `r`
 * and decrypts on the device, then shows the result through the shared presenter; a new FCM
 * token queues every relay-subscribed org for re-registration, the same path a changed
 * UnifiedPush endpoint takes.
 *
 * - Non-exported service (`com.google.firebase.MESSAGING_EVENT`); nothing here parses text
 *   beyond what the transport validates.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * ├── io.github.siavz.yaran.push.NotificationPresenter
 * ├── io.github.siavz.yaran.push.PendingRegistrationStore
 * ├── io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.SubscriptionStore
 * ├── io.github.siavz.yaran.push.relay.FcmRelayKeyStore
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport
 * External: com.google.firebase.messaging
 *
 * Used by: entry point (service and provider declared in mobile/android/app/src/play/relay-fcm/AndroidManifest.xml (relay-fcm builds only))
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.fcmrelay

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.github.siavz.yaran.push.NotificationPresenter
import io.github.siavz.yaran.push.PendingRegistrationStore
import io.github.siavz.yaran.push.PushPlugin
import io.github.siavz.yaran.push.SubscriptionStore
import io.github.siavz.yaran.push.relay.FcmRelayKeyStore
import io.github.siavz.yaran.push.relay.RelayFcmTransport

class FcmRelayMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val transport = RelayFcmTransport(FcmRelayKeyStore(this), SubscriptionStore(this), null) { null }
        val (orgId, payload) = transport.open(message.data) ?: return
        NotificationPresenter(this).apply { ensureChannels() }.handle(orgId, payload)
    }

    override fun onNewToken(token: String) {
        val subscriptions = SubscriptionStore(this)
        val pending = PendingRegistrationStore(this)
        val presenter = NotificationPresenter(this)
        for (orgId in subscriptions.orgIds()) {
            if (subscriptions.load(orgId)?.channel != "fcm_relay") continue
            pending.add(orgId)
            if (!PushPlugin.emit("endpointChanged", mapOf("orgId" to orgId))) presenter.postRefreshNeeded(orgId)
        }
    }
}
