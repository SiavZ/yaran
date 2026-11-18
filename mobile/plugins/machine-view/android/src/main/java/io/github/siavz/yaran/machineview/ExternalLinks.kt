/**
 * Opens a link the machine page may not navigate to itself: https and http in a Custom Tab,
 * `tel:` in the dialer, `mailto:` in a mail app. Only reached on a user gesture
 * (`NavigationPolicy` turns gesture-less external navigations into a block).
 *
 * - Main thread. A missing handler writes a diagnostics line with the scheme only.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.ExternalLinks
 * └── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * External: android.app, android.content, android.net, androidx.browser.customtabs
 *
 * Used by:
 * io.github.siavz.yaran.machineview.ExternalLinks
 * └── io.github.siavz.yaran.machineview.WindowEvents (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent

internal object ExternalLinks {
    fun open(activity: Activity, url: String, diagnostics: DiagnosticsSink) {
        val uri = Uri.parse(url)
        try {
            if (uri.scheme == "https" || uri.scheme == "http") CustomTabsIntent.Builder().build().launchUrl(activity, uri)
            else activity.startActivity(Intent(if (uri.scheme == "tel") Intent.ACTION_DIAL else Intent.ACTION_SENDTO, uri))
        } catch (e: ActivityNotFoundException) {
            diagnostics.append("machine-view no app for an external ${uri.scheme} link")
        }
    }
}
