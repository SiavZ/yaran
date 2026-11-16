/**
 * Hijack probe activity: shows and logs any callback URL the system hands to the wrong app.
 *
 * G13 expects this app to NEVER receive the verified https callback, and records whether it
 * receives the `yaranapp-gate` custom-scheme callback on the Custom Tab path. It logs the
 * scheme, host, path and parameter names under tag `GateSpikeHijack`; a received `jwe` is
 * reported by presence only, which is all the evidence needs.
 *
 * - No network, no storage; a plain platform Activity with no AndroidX dependency.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.app, android.content, android.os, android.util, android.widget
 *
 * Used by: entry point (launcher and VIEW intent filters, hijack/src/main/AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike.hijack

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.widget.TextView

class HijackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        show(intent)
    }

    private fun show(intent: Intent) {
        val uri = intent.data
        val line = if (uri == null) {
            "no callback received (launched normally)"
        } else {
            "HIJACK RECEIVED ${uri.scheme}://${uri.host}${uri.path} params=${uri.queryParameterNames} " +
                "jwePresent=${uri.getQueryParameter("jwe") != null}"
        }
        Log.w("GateSpikeHijack", line)
        setContentView(TextView(this).apply {
            text = line
            setTextIsSelectable(true)
            setPadding(48, 160, 48, 48)
        })
    }
}
