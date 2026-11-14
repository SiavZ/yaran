/**
 * Receives the handoff redirect when it arrives as an intent (Custom Tab or plain VIEW).
 *
 * Both manifest aliases target this activity: `AuthCallbackHttps` (the App Link, enabled only
 * in builds with a publisher domain) and `AuthCallbackDev` (the custom scheme, enabled only
 * without one). It forwards the URI to the in-process handoff client and finishes at once;
 * `noHistory` keeps it off the back stack. The client decides everything: a callback in the
 * wrong form, with a foreign state, or after process death is refused or explained there.
 *
 * - Exported by necessity; it never displays or stores what it receives.
 * - Needs [CoreBindings] installed in `Application.onCreate`, since it can start a fresh process.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.AuthCallbackActivity
 * └── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * External: android.app, android.content, android.os
 *
 * Used by: entry point (exported Activity, the AuthCallbackHttps/AuthCallbackDev aliases in the plugin AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class AuthCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        forward(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        forward(intent)
        finish()
    }

    private fun forward(intent: Intent?) {
        val uri = intent?.dataString ?: return
        val waiting = SignInFlow.inFlight()
        SignInFlow.onRedirect(this, uri)
        // After a process death nobody is waiting: the client ends it "interrupted"; bring the app back.
        if (!waiting) packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it) }
    }
}
