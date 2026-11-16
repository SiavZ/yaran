/**
 * Applies the navigation and refusal policies to the machine WebView's traffic.
 *
 * Every navigation goes through [NavigationPolicy] before it happens, so control URLs and
 * Access redirects never load and off-host links leave only on a gesture. Main-frame HTTP
 * errors go through [RefusalPolicy] (`Yaran-Refusal`, 530). TLS errors cancel and never
 * prompt; a renderer crash returns true and hands the WebView back to be destroyed.
 *
 * - Main thread; all decisions are reported to the [MachineWindow].
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineWebViewClient
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * └── io.github.siavz.yaran.machineview.RefusalPolicy (inferred)
 * External: android.net.http, android.webkit
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineWebViewClient
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.net.http.SslError
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/** What the clients report to the activity hosting the machine WebView. */
internal interface MachineWindow {
    val host: String

    fun onNavigation(decision: NavDecision, url: String)

    fun onRefusal(decision: RefusalDecision, code: String?)

    fun onTlsError()

    fun onLoadFailed()

    fun onRendererGone(view: WebView)

    fun onHistoryChanged(url: String)
}

internal class MachineWebViewClient(private val window: MachineWindow) : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        val d = NavigationPolicy.decide(window.host, url, request.isForMainFrame, false, request.hasGesture())
        return when (d.action) {
            NavAction.ALLOW, NavAction.ALLOW_IN_PLACE -> false
            NavAction.REAUTH, NavAction.CLOSE_HOME, NavAction.CLOSE_SETTINGS, NavAction.EXTERNAL, NavAction.BLOCK, NavAction.IGNORE -> {
                window.onNavigation(d, url)
                true
            }
        }
    }

    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
        if (!request.isForMainFrame) return
        val code = response.responseHeaders?.entries?.firstOrNull { it.key.equals(RefusalPolicy.HEADER, ignoreCase = true) }?.value
        val d = RefusalPolicy.decide(response.statusCode, code)
        if (d.overlay != RefusalOverlay.NONE) window.onRefusal(d, code)
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
        window.onTlsError()
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) window.onLoadFailed()
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        window.onRendererGone(view)
        return true
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        window.onHistoryChanged(url)
    }
}
