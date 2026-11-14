/**
 * PushSpike: the G5 Android probe for UnifiedPush Web Push, shared by both flavors.
 *
 * Registers with a pasted VAPID public key through the UnifiedPush connector 3.x and reports
 * the endpoint, `p256dh` and `auth` to the shell's debug screen (copyable), plus every
 * decrypted `onMessage` payload and every registration failure. The flavors differ only in
 * dependencies: `foss` has the connector alone and needs an installed distributor app;
 * `play` adds the embedded FCM distributor, which registers under this app's own package and
 * is preferred, with no `google-services.json` and no publisher FCM credentials.
 *
 * - A device with no distributor (foss) or no Play Services (play) must surface a clear error,
 *   both in logcat (tag `GateSpike`) and as a `push` `failed` event.
 * - Logcat gets the endpoint HOST only; the full endpoint and keys go to the debug screen,
 *   because G5 pastes them into `web-push` (evidence is redacted by the gate scripts).
 * - [GatePushService] runs on the connector's service thread; events reach the shell only if
 *   the bridge is alive (retained until a listener consumes them).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.PushSpike
 * ├── io.github.siavz.yaran.gatespike.BuildConfig
 * └── io.github.siavz.yaran.gatespike.MachineViewSpike   (TAG)
 * External: org.unifiedpush.android.connector, com.getcapacitor
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.PushSpike
 * └── io.github.siavz.yaran.gatespike.MainActivity
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import android.net.Uri
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.lang.ref.WeakReference

private const val PUSH_INSTANCE = "gate"

// An uncompressed P-256 point is 65 bytes: 87 base64url characters, 88 with padding.
private val VAPID_SHAPE = Regex("^[A-Za-z0-9_-]{87}=?$")

@CapacitorPlugin(name = "PushSpike")
class PushSpike : Plugin() {
    override fun load() {
        instance = WeakReference(this)
    }

    @PluginMethod
    fun register(call: PluginCall) {
        val vapid = call.getString("vapidPublicKey").orEmpty()
        if (!VAPID_SHAPE.matches(vapid)) {
            call.reject("paste the VAPID PUBLIC key (87 base64url characters) from web-push generate-vapid-keys")
            return
        }
        val distributors = UnifiedPush.getDistributors(context)
        Log.i(TAG, "push flavor=${BuildConfig.FLAVOR} distributors=$distributors")
        if (distributors.isEmpty()) {
            fail(call, "no UnifiedPush distributor on this device (flavor ${BuildConfig.FLAVOR}); install one such as ntfy, or use the play flavor")
            return
        }
        // play: the embedded FCM distributor answers under our own package name; prefer it.
        val known = UnifiedPush.getAckDistributor(context)
            ?: context.packageName.takeIf { it in distributors }
        if (known != null) {
            UnifiedPush.saveDistributor(context, known)
            startRegistration(call, vapid, known)
            return
        }
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { ok ->
            if (ok) startRegistration(call, vapid, UnifiedPush.getSavedDistributor(context))
            else fail(call, "no default UnifiedPush distributor selected; candidates were $distributors")
        }
    }

    private fun startRegistration(call: PluginCall, vapid: String, distributor: String?) {
        try {
            UnifiedPush.register(context, PUSH_INSTANCE, vapid = vapid)
        } catch (e: Exception) {
            fail(call, "UnifiedPush.register threw ${e.javaClass.simpleName}: ${e.message}")
            return
        }
        Log.i(TAG, "push register sent to distributor=$distributor; waiting for onNewEndpoint")
        call.resolve(JSObject().put("started", true).put("distributor", distributor))
    }

    private fun fail(call: PluginCall, why: String) {
        emit(JSObject().put("kind", "failed").put("reason", why))
        call.reject(why)
    }

    companion object {
        @Volatile private var instance: WeakReference<PushSpike>? = null

        fun emit(event: JSObject) {
            if (event.getString("kind") == "failed") Log.w(TAG, "push failed ${event.getString("reason")}")
            instance?.get()?.notifyListeners("push", event, true)
        }
    }
}

/** UnifiedPush connector 3.x callback service (manifest action `...connector.PUSH_EVENT`). */
class GatePushService : PushService() {
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        val keys = endpoint.pubKeySet
        Log.i(TAG, "push onNewEndpoint host=${Uri.parse(endpoint.url).host} temporary=${endpoint.temporary} keys=${keys != null}")
        PushSpike.emit(
            JSObject()
                .put("kind", "endpoint")
                .put("endpoint", endpoint.url)
                .put("p256dh", keys?.pubKey)
                .put("auth", keys?.auth)
                .put("temporary", endpoint.temporary),
        )
    }

    override fun onMessage(message: PushMessage, instance: String) {
        val payload = String(message.content, Charsets.UTF_8)
        Log.i(TAG, "push onMessage decrypted=${message.decrypted} payload=$payload")
        PushSpike.emit(JSObject().put("kind", "message").put("decrypted", message.decrypted).put("payload", payload))
    }

    override fun onRegistrationFailed(reason: FailedReason, instance: String) {
        PushSpike.emit(JSObject().put("kind", "failed").put("reason", "onRegistrationFailed ${reason.name}"))
    }

    override fun onUnregistered(instance: String) {
        Log.i(TAG, "push onUnregistered")
        PushSpike.emit(JSObject().put("kind", "unregistered"))
    }
}
