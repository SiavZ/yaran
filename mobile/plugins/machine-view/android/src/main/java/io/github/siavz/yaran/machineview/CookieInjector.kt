/**
 * Puts the `CF_Authorization` session cookie into the WebView cookie store, and takes it out.
 *
 * Injection awaits `setCookie`'s callback before the caller loads (the first-request race),
 * and under the G6 fallback also polls `getCookie` up to [Fallbacks.COOKIE_POLL_MS]. It runs
 * before every load and on every resume, because Capacitor's `CapacitorCookies` wipes session
 * cookies whenever the bridge starts. Clearing writes expired `CF_Authorization` and
 * `CF_AppSession` cookies for each host and flushes off the main thread.
 *
 * - Main thread for CookieManager calls; [clear] may be called from any thread.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CookieInjector
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.Fallbacks (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.os, android.webkit
 *
 * Used by:
 * io.github.siavz.yaran.machineview.CookieInjector
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager

internal class CookieInjector : WebDataCleaner {
    private val main = Handler(Looper.getMainLooper())

    fun inject(host: String, setCookie: String, done: (Boolean) -> Unit) {
        main.post {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setCookie(CookieSpec.cookieUrl(host), setCookie) { ok ->
                if (!ok || Fallbacks.COOKIE_POLL_MS <= 0) done(ok) else poll(host, SystemClock.uptimeMillis() + Fallbacks.COOKIE_POLL_MS, done)
            }
        }
    }

    private fun poll(host: String, deadline: Long, done: (Boolean) -> Unit) {
        val present = CookieManager.getInstance().getCookie(CookieSpec.cookieUrl(host))?.contains("CF_Authorization=") == true
        when {
            present -> done(true)
            SystemClock.uptimeMillis() >= deadline -> done(false)
            else -> main.postDelayed({ poll(host, deadline, done) }, 25)
        }
    }

    override fun clear(hosts: List<String>) {
        main.post {
            val cm = CookieManager.getInstance()
            for (host in hosts) CookieSpec.clearCookies.forEach { cm.setCookie(CookieSpec.cookieUrl(host), it) }
            Thread({ cm.flush() }, "machine-view-cookie-flush").start()
        }
    }
}
