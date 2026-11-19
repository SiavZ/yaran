/**
 * The direct-machine HTTP client (G1): the public status probe, `cli-login` and `cli-logout`.
 *
 * Every request goes to `https://<host>/` on the default port with redirects off: a 3xx is
 * classified (Access in front, or any other redirect) and never followed, so a password or a
 * session never leaves for another origin. A stored session is attached only to its own host,
 * and only after an unauthenticated answer proved the host is a yaran with the instance the
 * session was issued by. Plain `HttpURLConnection`, as `OrgApiClient` does it.
 *
 * - Blocking: callers run it on the plugin's io executor.
 * - Diagnostics name the host and the exception class only, never a body, token or password.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DirectAuth
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * └── io.github.siavz.yaran.machineview.NativeHttp (inferred)
 * External: java.io, java.net, javax.net.ssl
 *
 * Used by:
 * io.github.siavz.yaran.machineview.DirectAuth
 * ├── io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuthTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.FreshSignInRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeCookieIsolationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowRepairRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.WindowRound12RobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

internal class DirectAuth(
    private val userAgent: String,
    private val diagnostics: DiagnosticsSink,
    private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    private class Answer(val status: Int, val location: String?, val contentType: String?, val body: String)

    private sealed interface Sent {
        class Ok(val a: Answer) : Sent
        data object TooLarge : Sent
        data object Tls : Sent
        data object Offline : Sent
    }

    /**
     * The public status document; with [session], also whether that session is signed in there.
     * The session is sent only when it is bound to the instance that just answered, and that is
     * the [expected] one when a window recorded one: an unbound (older) session or another
     * instance never sees the token. Instance ids are public, so this is a consistency check, never
     * authorization; the host still is. The credentialed answer is the newer one and is returned as
     * it is classified (another instance, a build too old for the app, offline, a refusal), never
     * replaced by the public answer it followed, so the caller's mismatch or upgrade verdict holds.
     */
    fun status(host: String, session: DirectSession?, timeoutMs: Int = TIMEOUT_MS, expected: String? = null): DirectStatus {
        if (!DirectWire.isPublicHost(host)) return DirectStatus.Refused("invalid_host")
        val answer = get(host, null, timeoutMs)
        if (answer !is DirectStatus.Yaran || session == null || session.host != host) return answer
        if (!session.boundTo(answer.instance) || (expected != null && expected != answer.instance)) return answer
        val cookie = session.setCookie()?.substringBefore(";") ?: return answer
        return get(host, cookie, timeoutMs)
    }

    /** One status GET carrying [cookie] (a route probe brings its own credential). */
    fun get(host: String, cookie: String?, timeoutMs: Int = TIMEOUT_MS): DirectStatus =
        when (val s = send(host, DirectWire.STATUS_PATH, "GET", null, cookie, null, timeoutMs)) {
            is Sent.Ok -> s.a.let { DirectWire.classifyStatus(it.status, it.location, it.contentType, it.body) }
            Sent.TooLarge -> DirectStatus.Refused("response_too_large")
            Sent.Tls -> DirectStatus.TlsError
            Sent.Offline -> DirectStatus.Offline
        }

    /** POSTs [body] (zeroed by the caller afterwards) to `cli-login`; a stray token is revoked here. */
    fun login(host: String, body: ByteArray): LoginAnswer {
        val answer = when (val s = send(host, DirectWire.LOGIN_PATH, "POST", body, null, null, TIMEOUT_MS)) {
            is Sent.Ok -> s.a.let { DirectWire.classifyLogin(it.status, it.location, it.contentType, it.body) }
            Sent.TooLarge -> LoginAnswer.Failed(DirectSignInOutcome.Refused("response_too_large"))
            Sent.Tls -> LoginAnswer.Failed(DirectSignInOutcome.TlsError)
            Sent.Offline -> LoginAnswer.Failed(DirectSignInOutcome.Offline)
        }
        if (answer is LoginAnswer.Failed && answer.revoke != null) logout(host, answer.revoke)
        return answer
    }

    /** Ends [token] on the machine; true only when it answered 204. Best effort. */
    fun logout(host: String, token: String): Boolean {
        if (!DirectWire.isPublicHost(host) || !DirectWire.safeToken(token)) return false
        val s = send(host, DirectWire.LOGOUT_PATH, "POST", ByteArray(0), null, "Bearer $token", TIMEOUT_MS)
        return s is Sent.Ok && s.a.status == 204
    }

    /** Only the [cookie] given ever reaches the machine: never one of the WebView's ([NativeHttp]). */
    private fun send(host: String, path: String, method: String, body: ByteArray?, cookie: String?, bearer: String?, timeoutMs: Int): Sent =
        NativeHttp.isolated { exchange(host, path, method, body, cookie, bearer, timeoutMs) }

    private fun exchange(host: String, path: String, method: String, body: ByteArray?, cookie: String?, bearer: String?, timeoutMs: Int): Sent {
        val conn = try {
            NativeHttp.open { connect(URL("https://$host$path")) }
        } catch (e: IOException) {
            return Sent.Offline
        }
        try {
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.requestMethod = method
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Accept", "application/json")
            cookie?.let { conn.setRequestProperty("Cookie", it) }
            bearer?.let { conn.setRequestProperty("Authorization", it) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                // Not streaming mode: there a 401 is a retry error and its refusal body is lost. The stack keeps its own
                // copy of the body either way, so zeroing the caller's bytes is best effort.
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else if (status in 300..399) null else conn.inputStream
            val bytes = stream?.use { readCapped(it) } ?: ByteArray(0)
            if (bytes.size > MAX_RESPONSE) return Sent.TooLarge
            return Sent.Ok(Answer(status, conn.getHeaderField("Location"), conn.contentType, String(bytes, Charsets.UTF_8)))
        } catch (e: SSLException) {
            diagnostics.append("machine-view direct tls error host=$host")
            return Sent.Tls
        } catch (e: IOException) {
            diagnostics.append("machine-view direct offline host=$host (${e.javaClass.simpleName})")
            return Sent.Offline
        } finally {
            conn.disconnect()
        }
    }

    private fun readCapped(input: InputStream): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() <= MAX_RESPONSE) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    companion object {
        const val TIMEOUT_MS = 15_000
        const val MAX_RESPONSE = 64 * 1024

        /** A route probe's deadline: a tailnet name answers fast or not at all. */
        fun probeTimeoutMs(host: String) = if (host.endsWith(".ts.net")) 3_000 else 8_000
    }
}
