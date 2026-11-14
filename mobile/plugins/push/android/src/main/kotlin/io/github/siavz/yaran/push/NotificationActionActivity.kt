/**
 * Trampoline for the "Mute this machine" notification action: forwards the ids to the app's
 * launcher activity, where the shell applies the mute on the Worker and confirms with a toast.
 *
 * - Non-exported; reached only through the plugin's own immutable `PendingIntent`.
 * - Copies only the known id extras, so nothing else rides into the app.
 * - It stays a foreground action because the confirmation toast and Phase 14's app lock both
 *   need the app in front.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.NotificationActionActivity
 * └── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * External: android.app, android.content, android.os
 *
 * Used by:
 * io.github.siavz.yaran.push.NotificationActionActivity
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * └── io.github.siavz.yaran.push.PushPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class NotificationActionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            for (key in FORWARDED) intent.getStringExtra(key)?.let { launch.putExtra(key, it) }
            startActivity(launch)
        }
        finish()
    }

    companion object {
        val FORWARDED = listOf(
            NotificationPresenter.EXTRA_TAP_ACTION,
            NotificationPresenter.EXTRA_ORG,
            NotificationPresenter.EXTRA_MACHINE,
            NotificationPresenter.EXTRA_AGENT,
            NotificationPresenter.EXTRA_TAB,
        )
    }
}
