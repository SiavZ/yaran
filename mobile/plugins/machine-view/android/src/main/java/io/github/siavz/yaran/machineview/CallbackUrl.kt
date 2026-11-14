/**
 * Validates a handoff callback: the form this build sends, its exact shape, state and age.
 *
 * Release builds accept only `https://<publisher-domain>/auth/callback`, dev builds only
 * `yaranapp://auth/callback` (D8); the other form is refused. Parameters come from the query,
 * else the fragment (G13's `mode=fragment`), and must be exactly the success or the error
 * shape of 02's `HandoffCallback`. The state is compared in constant time with the pending
 * entry, which must be at most ten minutes old. Pinned by `fixtures/callback-cases.json`.
 *
 * - Pure. The `jwe` value is returned for opening and never logged.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CallbackUrl
 * ├── io.github.siavz.yaran.machineview.ControlUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.security
 *
 * Used by:
 * io.github.siavz.yaran.machineview.CallbackUrl
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffUrlFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.security.MessageDigest

internal sealed interface CallbackMode {
    data class Https(val domain: String) : CallbackMode
    data object Dev : CallbackMode
}

internal data class PendingRef(val state: String, val createdAt: Long)

internal enum class CallbackRefusal { WRONG_FORM, MALFORMED, NO_PENDING, STATE_MISMATCH, EXPIRED }

internal sealed interface CallbackResult {
    data class Success(val jwe: String) : CallbackResult {
        override fun toString() = "Success(jwe=<redacted>)"
    }
    data class Error(val code: String, val min: Int?, val max: Int?, val serverTime: Long?) : CallbackResult
    data class Refused(val reason: CallbackRefusal) : CallbackResult
}

internal object CallbackUrl {
    const val TTL_S = 600L
    private const val PATH = "/auth/callback"
    private val STATE = Regex("^[A-Za-z0-9_-]{22,128}$")
    private val JWE = Regex("^[A-Za-z0-9_-]+\\.\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
    private val ERROR = Regex("^[a-z][a-z0-9_]{0,63}$")
    private val VERSION = Regex("^[1-9][0-9]{0,4}$")
    private val TIME = Regex("^(?:0|[1-9][0-9]{0,11})$")

    fun parse(mode: CallbackMode, uri: String, pending: PendingRef?, now: Long): CallbackResult {
        val u = UrlParts.parse(uri)
        if (u == null || !formMatches(mode, u)) return CallbackResult.Refused(CallbackRefusal.WRONG_FORM)
        val p = UriParams.parseUri(uri) ?: return CallbackResult.Refused(CallbackRefusal.MALFORMED)
        val params = if (p.query.isNotEmpty()) p.query else p.fragment
        val shaped = shape(params) ?: return CallbackResult.Refused(CallbackRefusal.MALFORMED)
        if (pending == null) return CallbackResult.Refused(CallbackRefusal.NO_PENDING)
        if (!MessageDigest.isEqual(params.getValue("state").toByteArray(), pending.state.toByteArray())) {
            return CallbackResult.Refused(CallbackRefusal.STATE_MISMATCH)
        }
        if (now - pending.createdAt > TTL_S) return CallbackResult.Refused(CallbackRefusal.EXPIRED)
        return shaped
    }

    private fun formMatches(mode: CallbackMode, u: UrlParts): Boolean = when (mode) {
        is CallbackMode.Https -> u.scheme == "https" && u.path == PATH && u.authority?.lowercase() == mode.domain.lowercase()
        CallbackMode.Dev -> u.scheme == "yaranapp" && u.authority == "auth" && u.path == "/callback"
    }

    private fun shape(params: Map<String, String>): CallbackResult? {
        val state = params["state"] ?: return null
        if (!STATE.matches(state)) return null
        val jwe = params["jwe"]
        val error = params["error"]
        if (jwe != null) {
            if (params.size != 2 || jwe.length > 8192 || !JWE.matches(jwe)) return null
            return CallbackResult.Success(jwe)
        }
        if (error == null || !ERROR.matches(error)) return null
        val allowed = mutableSetOf("state", "error")
        if (error == "protocol_unsupported") allowed += listOf("min", "max")
        if (error == "handoff_timestamp_skewed") allowed += "server_time"
        if (!allowed.containsAll(params.keys)) return null
        val min = params["min"]?.let { if (VERSION.matches(it)) it.toInt() else return null }
        val max = params["max"]?.let { if (VERSION.matches(it)) it.toInt() else return null }
        val serverTime = params["server_time"]?.let { if (TIME.matches(it)) it.toLong() else return null }
        return CallbackResult.Error(error, min, max, serverTime)
    }
}
