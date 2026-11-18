/**
 * Native HTTP never carries the WebView's cookies, and never stores any (Sol native review rounds 4, 5).
 *
 * `HttpURLConnection` takes the process-wide `CookieHandler` when the connection is created
 * (the JDK's in its constructor, Android's bundled OkHttp in `OkUrlFactory.open`), and Capacitor
 * installs one backed by the WebView's own jar at every bridge start. So the guard is made part of
 * the connection itself: [open] installs it, if needed, and creates the connection under one lock,
 * and the app runs each bridge start through [frameworkStart], which re-wraps what Capacitor
 * installed under the same lock. A handler that lands between the two is therefore impossible, and
 * a later one never reaches a connection already open. While a thread runs [isolated] the guard
 * answers no cookie and keeps none; every other request reaches the wrapped handler unchanged.
 *
 * - The lock is held only for a connection's creation (no network I/O) and for a bridge start.
 * - Assumes the platform takes the handler at creation, as both stacks above do; a stack that read
 *   it per request would need the guard installed by the framework itself.
 *
 * <module-headers:begin>
 * Uses: none
 * External: java.net
 *
 * Used by:
 * io.github.siavz.yaran.machineview.NativeHttp
 * ├── io.github.siavz.yaran.app.MainActivity
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeCookieIsolationRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.net.CookieHandler
import java.net.URI
import java.net.URLConnection

object NativeHttp {
    private val native = ThreadLocal<Boolean>()
    private val lock = Any()

    private class Guard(val inner: CookieHandler?) : CookieHandler() {
        override fun get(uri: URI, requestHeaders: Map<String, List<String>>): Map<String, List<String>> =
            if (native.get() == true) emptyMap() else inner?.get(uri, requestHeaders) ?: emptyMap()

        override fun put(uri: URI, responseHeaders: Map<String, List<String>>) {
            if (native.get() != true) inner?.put(uri, responseHeaders)
        }
    }

    private fun ensure() {
        val current = CookieHandler.getDefault()
        if (current !is Guard) CookieHandler.setDefault(Guard(current))
    }

    /** Runs [exchange] (open, send, read) with no implicit cookie in or out; its connection comes from [open]. */
    internal fun <T> isolated(exchange: () -> T): T {
        native.set(true)
        return try {
            exchange()
        } finally {
            native.remove()
        }
    }

    /** Creates a connection with the guard as its cookie handler, whatever a bridge start is doing. */
    internal fun <C : URLConnection> open(create: () -> C): C = synchronized(lock) {
        ensure()
        create()
    }

    /** Runs a step that may install a process-wide cookie handler (a Capacitor bridge start), then wraps it. */
    fun <T> frameworkStart(start: () -> T): T = synchronized(lock) {
        try {
            start()
        } finally {
            ensure()
        }
    }
}
