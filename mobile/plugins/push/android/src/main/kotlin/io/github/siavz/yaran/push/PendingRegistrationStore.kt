/**
 * Orgs whose push endpoint changed (or died) while the WebView was not running.
 *
 * `YaranPushService` adds an org when the distributor hands it a new endpoint or unregisters it
 * outside a `registerDevice` call; the shell drains the set on its next start and re-registers
 * each org, so a changed endpoint always reaches the Worker.
 *
 * - Plain `SharedPreferences` with synchronous commits: the set must survive process death,
 *   which is exactly when it matters. Nothing here is secret.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content
 *
 * Used by:
 * io.github.siavz.yaran.push.PendingRegistrationStore
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * └── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.content.Context

class PendingRegistrationStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    fun add(orgId: String) {
        prefs.edit().putStringSet(KEY, orgIds() + orgId).commit()
    }

    fun orgIds(): Set<String> = prefs.getStringSet(KEY, emptySet()).orEmpty().toSet()

    /** Returns the queued orgs and empties the queue. */
    @Synchronized
    fun drain(): Set<String> {
        val ids = orgIds()
        prefs.edit().remove(KEY).commit()
        return ids
    }

    companion object {
        const val PREFS = "yaran_push_pending"
        private const val KEY = "orgs"
    }
}
