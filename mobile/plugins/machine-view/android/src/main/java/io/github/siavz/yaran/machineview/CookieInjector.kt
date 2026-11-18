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
import android.webkit.WebStorage

internal class CookieInjector : WebDataCleaner {
    private val main = Handler(Looper.getMainLooper())

    /**
     * Sets [setCookie] for [host] on the main thread. [owned] is asked right before the cookie is
     * set, inside the queued step: a window closed or replaced while it waited changes nothing.
     */
    fun inject(host: String, setCookie: String, owned: () -> Boolean = { true }, done: (Boolean) -> Unit) {
        main.post {
            if (!owned()) return@post done(false)
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            cm.setCookie(CookieSpec.cookieUrl(host), setCookie) { ok ->
                val name = setCookie.substringBefore('=') + "="
                if (!ok || Fallbacks.COOKIE_POLL_MS <= 0) done(ok) else poll(host, name, SystemClock.uptimeMillis() + Fallbacks.COOKIE_POLL_MS, done)
            }
        }
    }

    private fun poll(host: String, name: String, deadline: Long, done: (Boolean) -> Unit) {
        val present = CookieManager.getInstance().getCookie(CookieSpec.cookieUrl(host))?.split("; ")?.any { it.startsWith(name) } == true
        when {
            present -> done(true)
            SystemClock.uptimeMillis() >= deadline -> done(false)
            else -> main.postDelayed({ poll(host, name, deadline, done) }, 25)
        }
    }

    /**
     * A direct machine's sign-out: expires every cookie the store shows for [host] (host-only,
     * `Path=/`) and, with [storage], deletes the origin's web storage (a dropped stale session keeps
     * the page's drafts). Cookies set with another path or a parent
     * domain are not reachable this way; yaran sets neither.
     */
    fun clearHost(host: String, storage: Boolean = true, owned: () -> Boolean = { true }) {
        main.post {
            if (!owned()) return@post // the window that dropped the session moved on: the jar may be another's now
            val cm = CookieManager.getInstance()
            val url = CookieSpec.cookieUrl(host)
            cm.getCookie(url)?.split(";")?.map { it.trim().substringBefore('=') }?.filter { it.isNotEmpty() }?.toSet()?.forEach {
                // Overwrite the value first, then expire: the secret is gone even where an expiry is not honoured at once.
                cm.setCookie(url, "$it=; Path=/; Secure; HttpOnly")
                cm.setCookie(url, "$it=; Path=/; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
            }
            if (storage) WebStorage.getInstance().deleteOrigin("https://$host")
            Thread({ cm.flush() }, "machine-view-cookie-flush").start()
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
