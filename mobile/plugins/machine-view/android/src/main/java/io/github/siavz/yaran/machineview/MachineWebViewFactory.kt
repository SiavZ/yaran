/**
 * Creates the machine WebView with the hardened settings of the Phase 15 configuration table.
 *
 * No bridge of any kind (no `addJavascriptInterface`, no `addWebMessageListener`, no
 * document-start script: D9); JS and DOM storage on; file and content access off; mixed
 * content never; Safe Browsing on; one window only, so `window.open` and `_blank` pass through
 * the navigation policy; geolocation off; the UA token appended. Inspection only in debuggable
 * or e2e builds, never in a release variant (Phase 19 hook H4).
 *
 * - Main thread.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content, android.os, android.webkit
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineWebViewFactory
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Context
import android.os.Build
import android.webkit.WebSettings
import android.webkit.WebView

internal object MachineWebViewFactory {
    fun create(context: Context, debug: Boolean, uaToken: String): WebView {
        WebView.setWebContentsDebuggingEnabled(debug)
        return WebView(context).apply { configure(settings, uaToken) }
    }

    fun configure(s: WebSettings, uaToken: String) {
        s.javaScriptEnabled = true
        s.domStorageEnabled = true
        s.allowFileAccess = false
        s.allowContentAccess = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        s.setSupportMultipleWindows(false)
        s.javaScriptCanOpenWindowsAutomatically = false
        s.setGeolocationEnabled(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.safeBrowsingEnabled = true
        s.userAgentString = "${s.userAgentString} $uaToken"
    }
}
