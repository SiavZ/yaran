/**
 * UnifiedPush connector callbacks: endpoints, messages, failures and unregistrations, for every
 * org instance, whether or not the WebView is running.
 *
 * A new endpoint either completes the `registerDevice` call waiting for it or, when none is
 * waiting, is stored, queued in `PendingRegistrationStore` and announced (an `endpointChanged`
 * event when the shell is alive, else one local "need a refresh" notification), so a changed
 * endpoint is never lost silently. Messages go to the presenter; `decrypted == false` shows
 * only the generic text and is never parsed.
 *
 * - Non-exported service with the connector's `PUSH_EVENT` action (AndroidManifest.xml).
 * - The instance must be an org this phone subscribed; anything else is ignored.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.YaranPushService
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.PendingRegistrationStore (inferred)
 * ├── io.github.siavz.yaran.push.PushPayloadParser (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * ├── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * └── io.github.siavz.yaran.push.UnifiedPushRegistrar (inferred)
 * External: org.unifiedpush.android.connector, org.unifiedpush.android.connector.data
 *
 * Used by: entry point (UnifiedPush PushService, declared in mobile/plugins/push/android/src/main/AndroidManifest.xml)
 * io.github.siavz.yaran.push.YaranPushService
 * └── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class YaranPushService : PushService() {
    private val subscriptions by lazy { SubscriptionStore(this) }
    private val presenter by lazy { NotificationPresenter(this).also { it.ensureChannels() } }

    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val waiter = EndpointWaiters.take(instance)
        val keys = endpoint.pubKeySet
        val vapid = waiter?.vapidPublicKey ?: subscriptions.load(instance)?.vapidPublicKey
        if (keys == null || vapid == null || !endpoint.url.startsWith("https://")) {
            waiter?.future?.complete(SubscribeResult.Failed("the distributor gave an endpoint without HTTPS or encryption keys"))
            return
        }
        val distributor = org.unifiedpush.android.connector.UnifiedPush.getAckDistributor(this)
        val subscription = Subscription(
            endpoint = endpoint.url, p256dh = keys.pubKey, auth = keys.auth,
            channel = UnifiedPushRegistrar.channelFor(this, distributor), distributor = distributor, vapidPublicKey = vapid,
        )
        subscriptions.save(instance, subscription)
        if (waiter != null) {
            waiter.future.complete(SubscribeResult.Ok(subscription))
        } else {
            announceChange(instance)
        }
    }

    override fun onMessage(message: PushMessage, instance: String) {
        if (subscriptions.load(instance) == null) return
        val payload = if (message.decrypted) PushPayloadParser.parse(message.content) else null
        presenter.handle(instance, payload)
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        val why = when (reason) {
            FailedReason.INTERNAL_ERROR -> "the distributor had an internal error"
            FailedReason.NETWORK -> "the distributor could not reach its server"
            FailedReason.ACTION_REQUIRED -> "the distributor needs you to finish its setup"
            FailedReason.VAPID_REQUIRED -> "the distributor requires a VAPID key"
        }
        val waiter = EndpointWaiters.take(instance)
        if (waiter != null) {
            waiter.future.complete(SubscribeResult.Failed(why))
        } else {
            PushPlugin.emit("registrationFailed", mapOf("orgId" to instance, "reason" to why))
        }
    }

    override fun onUnregistered(instance: String) {
        EndpointWaiters.take(instance)?.future?.complete(SubscribeResult.Failed("the distributor unregistered this app"))
        if (subscriptions.load(instance) == null) return
        subscriptions.delete(instance)
        announceChange(instance)
    }

    private fun announceChange(orgId: String) {
        PendingRegistrationStore(this).add(orgId)
        if (!PushPlugin.emit("endpointChanged", mapOf("orgId" to orgId))) presenter.postRefreshNeeded(orgId)
    }
}
