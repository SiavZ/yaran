/**
 * Per-host sessions in the vault: the only place a JWT is stored at rest (D22, T37).
 *
 * Namespace `session/<host>` holds `{org_id, jwt, cookie?, exp, iat, email, credential_kind}`,
 * in the locked class when the app lock is on. `exp` is the earlier of the payload's and the
 * JWT's own (decoded, not verified: it came sealed from the authenticated host). Sign-out and
 * the `device_revoked` wipe remove the vault entries and, through [WebDataCleaner], the
 * WebView cookies of the same hosts.
 *
 * - Thread-safe through the vault; values never reach a log or `toString()`.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SessionStore
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Fallbacks (inferred)
 * └── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * External: org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.SessionStore
 * ├── io.github.siavz.yaran.machineview.CookieInjector (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinator (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinatorTest (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONException
import org.json.JSONObject

/** Clears the machine window's cookies (and data stores) for hosts being signed out. */
fun interface WebDataCleaner {
    fun clear(hosts: List<String>)
}

internal data class Session(
    val orgId: String,
    val jwt: String,
    val cookie: String?,
    val exp: Long,
    val iat: Long,
    val email: String,
    val credentialKind: CredentialKind,
) {
    override fun toString() = "Session(orgId=$orgId, exp=$exp, kind=${credentialKind.wire})"
}

internal class SessionStore(
    private val vault: SecretVault,
    private val appLock: AppLockState,
    private val diagnostics: DiagnosticsSink,
    private val cleaner: WebDataCleaner,
) {
    private fun ns(host: String) = "$PREFIX$host"

    fun put(orgId: String, payload: HandoffPayload) {
        val jwtExp = jwtExp(payload.jwt)
        if (jwtExp == null) diagnostics.append("machine-view session jwt exp unreadable host=${payload.host}; using the envelope exp")
        val exp = if (jwtExp == null) payload.exp else minOf(jwtExp, payload.exp)
        val o = JSONObject().put("org_id", orgId).put("jwt", payload.jwt).put("exp", exp).put("iat", payload.iat)
            .put("email", payload.email).put("credential_kind", Fallbacks.CREDENTIAL_RUNG.wire)
        payload.cookie?.let { o.put("cookie", it) }
        val cls = if (appLock.lockEnabled()) ProtectionClass.LOCKED else ProtectionClass.STANDARD
        vault.write(ns(payload.host), o.toString().toByteArray(Charsets.UTF_8), cls)
    }

    fun get(host: String): Session? {
        val bytes = vault.read(ns(host)) ?: return null
        val o = JSONObject(String(bytes, Charsets.UTF_8))
        return Session(
            o.getString("org_id"), o.getString("jwt"), if (o.has("cookie")) o.getString("cookie") else null,
            o.getLong("exp"), o.optLong("iat", 0), o.getString("email"),
            CredentialKind.fromWire(o.optString("credential_kind")) ?: CredentialKind.ACCESS_JWT,
        )
    }

    fun status(host: String, now: Long): Session? = get(host)?.takeIf { it.exp > now }

    fun hostsFor(orgId: String): List<String> =
        vault.list(PREFIX).map { it.removePrefix(PREFIX) }.filter { host -> runCatching { get(host)?.orgId == orgId }.getOrDefault(false) }

    /** Deletes [hosts] plus every other session of [orgId], then clears their web data. */
    fun signOut(orgId: String, hosts: List<String>): List<String> {
        val all = (hosts + runCatching { hostsFor(orgId) }.getOrDefault(emptyList())).distinct()
        all.forEach { vault.delete(ns(it)) }
        cleaner.clear(all)
        return all
    }

    companion object {
        const val PREFIX = "session/"

        /** The JWT payload's `exp`, or null when it cannot be read. */
        fun jwtExp(jwt: String): Long? {
            val part = jwt.split('.').getOrNull(1) ?: return null
            val bytes = B64url.decode(part) ?: return null
            return try {
                val v = JSONObject(String(bytes, Charsets.UTF_8)).opt("exp")
                when (v) {
                    is Int -> v.toLong()
                    is Long -> v
                    else -> null
                }
            } catch (e: JSONException) {
                null
            }
        }
    }
}
