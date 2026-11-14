/**
 * The UnifiedPush transport: one connector instance per org (instance = org id), registered
 * with that org's VAPID key, on `foss` through the user's distributor and on `play` through the
 * embedded FCM distributor when no external one is installed.
 *
 * `subscribe` reuses a stored subscription while it is bound to the same VAPID key and
 * distributor; otherwise it registers and blocks (on the plugin's own executor) until
 * `YaranPushService` reports the endpoint or a failure.
 *
 * - External distributors are preferred over this app's own embedded one, matching the
 *   connector's `tryUseCurrentOrDefaultDistributor`.
 * - Keys and decryption are the connector's own (Keystore-wrapped `DefaultKeyManager`).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.UnifiedPushRegistrar
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * └── io.github.siavz.yaran.push.SubscriptionStore (inferred)
 * External: android.content, java.util.concurrent, org.unifiedpush.android.connector
 *
 * Used by:
 * io.github.siavz.yaran.push.UnifiedPushRegistrar
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * └── io.github.siavz.yaran.push.YaranPushService (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.content.Context
import org.unifiedpush.android.connector.UnifiedPush
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** Registrations waiting for the distributor, keyed by org id; completed by `YaranPushService`. */
object EndpointWaiters {
    class Pending(val vapidPublicKey: String, val future: CompletableFuture<SubscribeResult> = CompletableFuture())

    private val pending = ConcurrentHashMap<String, Pending>()

    fun start(orgId: String, vapid: String): Pending = Pending(vapid).also { pending[orgId] = it }
    fun take(orgId: String): Pending? = pending.remove(orgId)
}

class UnifiedPushRegistrar(
    private val context: Context,
    private val subscriptions: SubscriptionStore,
    private val timeoutSeconds: Long = 30,
) : SubscriptionSource {
    fun distributors(): List<String> = UnifiedPush.getDistributors(context)

    fun selected(): String? = UnifiedPush.getSavedDistributor(context)

    /** This app's embedded FCM distributor answers under its own package name (`play`). */
    fun embedded(): String? = context.packageName.takeIf { it in distributors() }

    fun select(distributor: String) {
        UnifiedPush.saveDistributor(context, distributor)
    }

    override fun subscribe(orgId: String, vapidPublicKey: String): SubscribeResult {
        val distributor = selected()?.takeIf { it in distributors() } ?: pickDefault() ?: return SubscribeResult.NoDistributor
        subscriptions.load(orgId)?.let {
            if (it.vapidPublicKey == vapidPublicKey && it.distributor == distributor) return SubscribeResult.Ok(it)
        }
        val waiter = EndpointWaiters.start(orgId, vapidPublicKey)
        try {
            UnifiedPush.register(context, orgId, null, vapidPublicKey)
        } catch (e: Exception) {
            EndpointWaiters.take(orgId)
            return SubscribeResult.Failed("the distributor refused the registration (${e.javaClass.simpleName})")
        }
        return try {
            waiter.future.get(timeoutSeconds, TimeUnit.SECONDS)
        } catch (_: TimeoutException) {
            EndpointWaiters.take(orgId)
            SubscribeResult.Unavailable("the push distributor did not answer within $timeoutSeconds seconds")
        }
    }

    override fun forget(orgId: String) {
        runCatching { UnifiedPush.unregister(context, orgId) }
    }

    /** External distributors first, then this app's embedded one; saved so the choice sticks. */
    private fun pickDefault(): String? {
        val all = distributors()
        val pick = all.firstOrNull { it != context.packageName } ?: all.firstOrNull() ?: return null
        select(pick)
        return pick
    }

    companion object {
        /** 02 `PushChannel` for a distributor package. */
        fun channelFor(context: Context, distributor: String?): String =
            if (distributor == context.packageName) "fcm_embedded" else "unifiedpush"
    }
}
