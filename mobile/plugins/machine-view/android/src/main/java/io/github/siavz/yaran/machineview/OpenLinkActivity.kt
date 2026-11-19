/**
 * Receives a verified agent link, `https://<publisher-domain>/open#…` (G6), and hands it to the
 * app's own launch activity as a VIEW intent, where the shell's link handler reads it.
 *
 * Only the alias `OpenLinkHttps` reaches it, with `autoVerify` and exactly that host and path,
 * enabled only in a build with a publisher domain. Nothing here parses the fragment or opens a
 * machine: the shell checks the link strictly and opens only a machine this phone already has.
 *
 * - Main thread; finishes at once.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.app, android.content, android.os
 *
 * Used by: entry point (Activity behind the OpenLinkHttps verified-link alias in the plugin AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.content.Intent
import android.os.Bundle

class OpenLinkActivity : Activity() {
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

    private fun forward(received: Intent?) {
        val uri = received?.data?.takeIf { it.scheme == "https" && it.path == "/open" } ?: return
        val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
        startActivity(Intent(launch).setAction(Intent.ACTION_VIEW).setData(uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
