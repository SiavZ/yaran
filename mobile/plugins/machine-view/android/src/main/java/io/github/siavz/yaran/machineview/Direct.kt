/**
 * Direct machines (G1): the wire rules, outcomes and the native-only session record.
 *
 * A direct machine is a yaran reached over HTTPS on the default port without Cloud Connect.
 * Its password is typed into a native sheet and posted to the existing `cli-login`; the CLI
 * token that comes back lives only here, under the reserved vault namespace `session-direct`
 * (JS `SecureStore` refuses every `session*` namespace), and reaches the WebView only as the
 * host-only `yaran_session_<port>` cookie. Pinned by `fixtures/direct-cases.json`, which the
 * Swift twin (`Direct.swift`) reads too; the wire is docs/operations/mobile-parity-contracts.md.
 *
 * - Pure apart from [DirectSessionStore], which goes through the vault seam.
 * - No outcome carries the password, the token or the cookie name; `toString` redacts.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.Direct
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.nio, java.nio.charset, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Direct
 * ├── io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdaptersTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuthTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffFailureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeCookieIsolationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteDriver (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowRepairRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.WindowRound12RobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction

sealed class DirectStatus(val kind: String) {
    data class Yaran(
        val instance: String?,
        val passwordSet: Boolean,
        val requiredHere: Boolean,
        val signedIn: Boolean,
        val transportEncrypted: Boolean,
    ) : DirectStatus("yaran")
    data object NotYaran : DirectStatus("not_yaran")
    data object AccessRequired : DirectStatus("access_required")
    data object Redirected : DirectStatus("redirected")
    data object Offline : DirectStatus("offline")
    data object TlsError : DirectStatus("tls_error")
    data object VaultLocked : DirectStatus("vault_locked")

    /** A yaran whose status lacks `native_auth_ui: true`: its page could ask for the password in the window. */
    data object UpgradeRequired : DirectStatus("upgrade_required")
    data class Refused(val reason: String) : DirectStatus("refused")

    /** The same failure as a sign-in outcome (the kinds are shared). */
    fun asSignIn(): DirectSignInOutcome = when (this) {
        is Yaran -> error("a yaran answer is not a failure")
        NotYaran -> DirectSignInOutcome.NotYaran
        AccessRequired -> DirectSignInOutcome.AccessRequired
        Redirected -> DirectSignInOutcome.Redirected
        Offline -> DirectSignInOutcome.Offline
        TlsError -> DirectSignInOutcome.TlsError
        VaultLocked -> DirectSignInOutcome.VaultLocked
        UpgradeRequired -> DirectSignInOutcome.UpgradeRequired
        is Refused -> DirectSignInOutcome.Refused(reason)
    }

    fun toJs(): Map<String, Any?> = when (this) {
        is Yaran -> linkedMapOf(
            "kind" to kind, "instance" to instance, "passwordSet" to passwordSet, "requiredHere" to requiredHere,
            "signedIn" to signedIn, "transportEncrypted" to transportEncrypted,
        )
        is Refused -> linkedMapOf("kind" to kind, "reason" to reason)
        NotYaran, AccessRequired, Redirected, Offline, TlsError, VaultLocked, UpgradeRequired -> linkedMapOf("kind" to kind)
    }
}

sealed class DirectSignInOutcome(val kind: String) {
    data class SignedIn(val host: String, val instance: String?, val signInId: String) : DirectSignInOutcome("signed_in")
    data object NotRequired : DirectSignInOutcome("not_required")
    data object Cancelled : DirectSignInOutcome("cancelled")
    data class WrongPassword(val message: String) : DirectSignInOutcome("wrong_password")
    data class RateLimited(val retryAfterSeconds: Long, val message: String) : DirectSignInOutcome("rate_limited")
    data class NoPassword(val message: String) : DirectSignInOutcome("no_password")
    data class ServerRefused(val status: Int, val code: String, val message: String) : DirectSignInOutcome("server_refused")
    data object NotYaran : DirectSignInOutcome("not_yaran")
    data object AccessRequired : DirectSignInOutcome("access_required")
    data object Redirected : DirectSignInOutcome("redirected")
    data object Offline : DirectSignInOutcome("offline")
    data object TlsError : DirectSignInOutcome("tls_error")
    data object VaultLocked : DirectSignInOutcome("vault_locked")
    data object UpgradeRequired : DirectSignInOutcome("upgrade_required")
    data class Refused(val reason: String) : DirectSignInOutcome("refused")

    /** The vault failed to keep the session while unlocked; the machine's token was revoked. */
    data object SecureStorageFailed : DirectSignInOutcome("secure_storage_failed")

    fun toJs(): Map<String, Any?> {
        val m = linkedMapOf<String, Any?>("kind" to kind)
        when (this) {
            is SignedIn -> m += mapOf("host" to host, "instance" to instance, "signInId" to signInId)
            is WrongPassword -> m["message"] = message
            is RateLimited -> m += mapOf("retryAfterSeconds" to retryAfterSeconds, "message" to message)
            is NoPassword -> m["message"] = message
            is ServerRefused -> m += mapOf("status" to status, "code" to code, "message" to message)
            is Refused -> m["reason"] = reason
            NotRequired, Cancelled, NotYaran, AccessRequired, Redirected, Offline, TlsError, VaultLocked, UpgradeRequired, SecureStorageFailed -> Unit
        }
        return m
    }
}

/** What a `cli-login` answer means: a session to keep, or an outcome (and whether a stray token must be revoked). */
internal sealed interface LoginAnswer {
    class Token(val token: String, val cookieName: String) : LoginAnswer {
        override fun toString() = "Token(<redacted>)"
    }
    data class Failed(val outcome: DirectSignInOutcome, val revoke: String? = null) : LoginAnswer {
        override fun toString() = "Failed(${outcome.kind})"
    }
}

internal object DirectWire {
    const val STATUS_PATH = "/api/v1/auth/status"
    const val LOGIN_PATH = "/api/v1/auth/cli-login"
    const val LOGOUT_PATH = "/api/v1/auth/cli-logout"
    const val MAX_MESSAGE = 300
    private const val ACCESS_SUFFIX = ".cloudflareaccess.com"
    private const val ACCESS_LOGIN_PATH = "/cdn-cgi/access/login"
    private val COOKIE_NAME = Regex("^yaran_session_[0-9]{1,5}$")
    private val TOKEN = Regex("^[A-Za-z0-9_-]{1,256}$")
    private val CODE = Regex("^[a-z][a-z0-9_]{0,63}$")
    private val INSTANCE = Regex("^[\\x21-\\x7e]{1,128}$")

    /** The contract's `isPublicHost`: a lowercase DNS name of two or more labels, alphabetic TLD, no `xn--` label. */
    fun isPublicHost(host: String): Boolean =
        host.length <= 253 && HostRules.ORG_URL.matches("https://$host") && host.split('.').none { it.startsWith("xn--") }

    fun safeCookieName(name: String?) = name != null && COOKIE_NAME.matches(name)

    fun safeToken(token: String?) = token != null && TOKEN.matches(token)

    /** `yaran_session_<port>=<token>; Path=/; Secure; HttpOnly; SameSite=Strict`, host-only and session-scoped. */
    fun setCookie(name: String, token: String): String? =
        if (safeCookieName(name) && safeToken(token)) "$name=$token; $ATTRS" else null

    fun clearCookie(name: String): String = "$name=; $ATTRS; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT"

    private const val ATTRS = "Path=/; Secure; HttpOnly; SameSite=Strict"

    /** A machine's own sentence, made safe to show as text: no control or format characters, at most 300 code points. */
    fun cleanMessage(raw: Any?): String {
        val s = raw as? String ?: return ""
        val out = StringBuilder()
        var count = 0
        var i = 0
        while (i < s.length && count < MAX_MESSAGE) {
            val cp = s.codePointAt(i)
            val type = Character.getType(cp)
            if (type != Character.CONTROL.toInt() && type != Character.FORMAT.toInt()) {
                out.appendCodePoint(cp)
                count++
            }
            i += Character.charCount(cp)
        }
        return out.toString().trim()
    }

    /** True for a redirect into Cloudflare Access (its team domain, or the login path on any host). */
    fun isAccessRedirect(location: String?): Boolean {
        if (location == null) return false
        if (location.startsWith(ACCESS_LOGIN_PATH)) return true
        val u = UrlParts.parse(location) ?: return false
        val host = u.authority?.let { HostRules.hostPort(it) }?.first ?: return false
        return (host.endsWith(ACCESS_SUFFIX) && host.length > ACCESS_SUFFIX.length) || u.path.startsWith(ACCESS_LOGIN_PATH)
    }

    private fun redirect(status: Int, location: String?): Boolean? =
        if (status in 300..399) isAccessRedirect(location) else null

    fun classifyStatus(status: Int, location: String?, contentType: String?, body: String): DirectStatus {
        redirect(status, location)?.let { return if (it) DirectStatus.AccessRequired else DirectStatus.Redirected }
        if (status != 200 || contentType?.lowercase()?.contains("json") != true) return DirectStatus.NotYaran
        val value = parse(body) ?: return DirectStatus.Refused("not_json")
        val o = value as? JSONObject ?: return DirectStatus.NotYaran
        val flags = listOf("password_set", "required_here", "signed_in", "transport_encrypted").map { o.opt(it) as? Boolean }
        if (flags.any { it == null }) return DirectStatus.NotYaran
        val instance = when (val i = o.opt("instance")) {
            null, JSONObject.NULL -> null
            is String -> i.takeIf { INSTANCE.matches(it) } ?: return DirectStatus.NotYaran
            else -> return DirectStatus.NotYaran
        }
        // Compatibility only: a build whose page could take the password in the window is never admitted.
        if (o.opt("native_auth_ui") != true) return DirectStatus.UpgradeRequired
        return DirectStatus.Yaran(instance, flags[0]!!, flags[1]!!, flags[2]!!, flags[3]!!)
    }

    fun classifyLogin(status: Int, location: String?, contentType: String?, body: String): LoginAnswer {
        redirect(status, location)?.let {
            return LoginAnswer.Failed(if (it) DirectSignInOutcome.AccessRequired else DirectSignInOutcome.Redirected)
        }
        val json = contentType?.lowercase()?.contains("json") == true
        val o = if (json) parse(body) as? JSONObject else null
        if (status == 200) {
            o ?: return LoginAnswer.Failed(DirectSignInOutcome.Refused("not_json"))
            val token = o.opt("token") as? String
            if (!safeToken(token)) return LoginAnswer.Failed(DirectSignInOutcome.ServerRefused(200, "token_invalid", ""))
            val name = o.opt("cookie_name") as? String
            return when {
                name == null -> LoginAnswer.Failed(DirectSignInOutcome.ServerRefused(200, "cookie_name_missing", ""), token)
                !safeCookieName(name) -> LoginAnswer.Failed(DirectSignInOutcome.ServerRefused(200, "cookie_name_invalid", ""), token)
                else -> LoginAnswer.Token(token!!, name)
            }
        }
        val code = (o?.opt("error") as? String)?.takeIf { CODE.matches(it) } ?: "unknown"
        val message = cleanMessage(o?.opt("message"))
        val outcome = when {
            status == 401 && code == "wrong_password" -> DirectSignInOutcome.WrongPassword(message)
            status == 429 -> DirectSignInOutcome.RateLimited(((o?.opt("retry_after_seconds") as? Number)?.toLong() ?: 0L).coerceAtLeast(0), message)
            status == 409 && code == "no_password" -> DirectSignInOutcome.NoPassword(message)
            else -> DirectSignInOutcome.ServerRefused(status, code, message)
        }
        return LoginAnswer.Failed(outcome)
    }

    /**
     * `{"password":…,"label":…}` as UTF-8, built from the password's chars without a String, so
     * the caller can zero both the chars and these bytes once the request is written.
     */
    fun loginBody(password: CharArray, label: String): ByteArray {
        val escaped = CharArray(password.size * 6)
        var n = 0
        for (c in password) {
            val esc = when (c) {
                '"' -> "\\\""
                '\\' -> "\\\\"
                else -> if (c < ' ') "\\u%04x".format(c.code) else null
            }
            if (esc == null) escaped[n++] = c else esc.forEach { escaped[n++] = it }
        }
        val encoder = Charsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE)
        val pw = encoder.encode(CharBuffer.wrap(escaped, 0, n))
        escaped.fill('\u0000')
        val head = "{\"password\":\"".toByteArray(Charsets.UTF_8)
        val tail = ("\",\"label\":" + JSONObject.quote(label) + "}").toByteArray(Charsets.UTF_8)
        val out = ByteArray(head.size + pw.remaining() + tail.size)
        head.copyInto(out)
        val pwLen = pw.remaining()
        pw.get(out, head.size, pwLen)
        if (pw.hasArray()) pw.array().fill(0)
        tail.copyInto(out, head.size + pwLen)
        return out
    }

    private fun parse(text: String): Any? = try {
        val t = JSONTokener(text)
        val v = t.nextValue()
        if (t.nextClean() == 0.toChar()) v else null
    } catch (e: JSONException) {
        null
    }
}

/** The native-only record of a direct machine's session. */
/**
 * The native-only record of a direct machine's session. [signInId] is an opaque, non-secret
 * name for this one sign-in (random, never derived from the token): the shell holds it so a
 * cleanup it starts can only ever end the sign-in it started. Null for a record an older build
 * wrote.
 */
internal class DirectSession(
    val host: String,
    val token: String,
    val cookieName: String,
    val instance: String?,
    val issuedAt: Long,
    val signInId: String? = null,
) {
    fun setCookie(): String? = DirectWire.setCookie(cookieName, token)

    /** Only a session bound to a known instance, and to the one expected, may be sent at all. */
    fun boundTo(instance: String?) = this.instance != null && this.instance == instance

    /**
     * May this record be used for a window that [observed] this instance and itself just signed in
     * as [fresh]? Bound to the observed instance, or, only while no identity is known on either side
     * (a machine without an instance id), the window's own fresh sign-in. A fresh id never outweighs
     * a known instance: a mismatch is a mismatch. Instance ids are public: consistency, not auth.
     */
    fun usable(observed: String?, fresh: String?) = boundTo(observed) || ownFresh(observed, fresh)

    /** The fresh-sign-in bootstrap of [usable]: no instance on either side, and this is that sign-in. */
    fun ownFresh(observed: String?, fresh: String?) = observed == null && instance == null && fresh != null && signInId == fresh

    override fun toString() = "DirectSession(host=$host, instance=$instance, issuedAt=$issuedAt, signInId=$signInId)"
}

/** A stored record that exists but cannot be used: never "signed out", never silently replaced. */
class DirectRecordUnreadableException(cause: Throwable?) : Exception("the stored direct session is unreadable", cause)

internal class DirectSessionStore(private val vault: SecretVault) {
    private fun ns(host: String) = "$PREFIX$host"

    fun put(s: DirectSession) {
        val o = JSONObject().put("host", s.host).put("token", s.token).put("cookie_name", s.cookieName)
            .put("instance", s.instance ?: JSONObject.NULL).put("issued_at", s.issuedAt).put("sign_in_id", s.signInId ?: JSONObject.NULL)
        // Locked class from creation: enabling App Lock later must not leave this bearer readable.
        vault.write(ns(s.host), o.toString().toByteArray(Charsets.UTF_8), ProtectionClass.LOCKED)
    }

    /**
     * The record, or null when there is none. Throws [VaultLockedException] while locked and
     * [DirectRecordUnreadableException] when a record is there but corrupt or for another host.
     */
    fun get(host: String): DirectSession? {
        val bytes = try {
            vault.read(ns(host))
        } catch (e: VaultLockedException) {
            throw e
        } catch (e: Exception) {
            throw DirectRecordUnreadableException(e)
        } ?: return null
        return try {
            val o = JSONObject(String(bytes, Charsets.UTF_8))
            val s = DirectSession(o.getString("host"), o.getString("token"), o.getString("cookie_name"),
                if (o.isNull("instance")) null else o.getString("instance"), o.getLong("issued_at"),
                if (o.isNull("sign_in_id") || !o.has("sign_in_id")) null else o.getString("sign_in_id"))
            if (s.host != host || s.setCookie() == null) throw DirectRecordUnreadableException(null)
            s
        } catch (e: JSONException) {
            throw DirectRecordUnreadableException(e)
        }
    }

    /**
     * The record only when it is bound to [instance] (the one this window just observed), or it
     * is the sign-in this window itself just made ([fresh]). Anything else, a record from
     * another instance or an older build's unbound one, is deleted and [dropped] runs, so it can
     * never be attached to the machine now at [host].
     */
    fun current(host: String, instance: String?, fresh: String?, owned: () -> Boolean = { true }, dropped: () -> Unit): DirectSession? {
        val s = get(host) ?: return null
        if (s.usable(instance, fresh)) return s
        if (!owned()) return null // the asker is gone: what it would have dropped is somebody else's now
        delete(host)
        dropped()
        return null
    }

    /** True when a record exists; a locked or unreadable one still counts, so this never throws. */
    fun has(host: String): Boolean = try {
        vault.read(ns(host)) != null
    } catch (e: Exception) {
        true
    }

    fun delete(host: String) = vault.delete(ns(host))

    fun hosts(): List<String> = vault.list(PREFIX).map { it.removePrefix(PREFIX) }

    companion object {
        private val random = java.security.SecureRandom()

        /** A fresh opaque sign-in id: 128 random bits, base64url. */
        fun newSignInId(): String = B64url.encode(ByteArray(16).also(random::nextBytes))

        /** Under the reserved `session` prefix, so JS `SecureStore` can neither read nor write it. */
        const val PREFIX = "session-direct/"
    }
}
