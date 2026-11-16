/**
 * Binds the FCM token source into the push plugin at process start, in relay-fcm builds only.
 *
 * A no-op `ContentProvider` runs before any activity or service, so `PushBindings.fcmToken` is
 * set without `MainActivity` (shared by every flavor) knowing which transport the build has.
 *
 * - Non-exported; it answers no queries.
 * - The token call blocks, so it is only ever invoked on the plugin's registration executor.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.fcmrelay.FcmRelayInstaller
 * └── io.github.siavz.yaran.push.PushBindings
 * External: android.content, android.database, android.net, com.google.android.gms.tasks, com.google.firebase.messaging, java.util.concurrent
 *
 * Used by: entry point (service and provider declared in mobile/android/app/src/play/relay-fcm/AndroidManifest.xml (relay-fcm builds only))
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.fcmrelay

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.firebase.messaging.FirebaseMessaging
import io.github.siavz.yaran.push.PushBindings
import java.util.concurrent.TimeUnit

class FcmRelayInstaller : ContentProvider() {
    override fun onCreate(): Boolean {
        PushBindings.fcmToken = { runCatching { Tasks.await(FirebaseMessaging.getInstance().token, 20, TimeUnit.SECONDS) }.getOrNull() }
        return true
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int = 0
}
