/**
 * The only code in the app that talks to an org Worker (D22, T60).
 *
 * Every Worker call the shell and Phase 16 make (meta, machines, device registration, mutes)
 * goes through here, so bearer credentials never enter JS. Requests reach only the org origin
 * recorded at onboarding, under `/v1/`, with GET/POST/PATCH/DELETE; the control-plane token
 * rides as both `Cookie: CF_Authorization` and `cf-access-token` (02 §2). Redirects are never
 * followed, responses are JSON capped at 1 MiB, and `403 device_revoked` wipes that org's
 * sessions, install id and device key before it is reported.
 *
 * - Blocking; call from a background executor. Errors reach diagnostics as codes, never bodies.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.OrgApiClient
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.io, java.net, javax.net.ssl, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.OrgApiClient
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

internal class OrgApiClient(
    private val orgs: OrgDirectory,
    private val sessions: SessionStore,
    private val installIds: InstallIdStore,
    private val deviceKeys: DeviceKeyStore,
    private val wipeOrg: (String) -> Unit,
    private val userAgent: String,
    private val now: () -> Long,
    private val diagnostics: DiagnosticsSink,
    private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    fun meta(orgUrl: String): ApiResult {
        if (!HostRules.ORG_URL.matches(orgUrl)) return ApiResult.Refused("origin")
        return send(URL("$orgUrl$META_PATH"), "GET", null, emptyMap(), credentialed = false, orgId = null)
    }

    fun request(orgId: String, method: String, path: String, body: Any?): ApiResult {
        val orgUrl = orgs.orgUrl(orgId) ?: return ApiResult.Refused("unknown_org")
        if (!HostRules.ORG_URL.matches(orgUrl)) return ApiResult.Refused("origin")
        if (method !in METHODS) return ApiResult.Refused("method")
        if (!pathOk(path)) return ApiResult.Refused("path")
        val bodyText = body?.let { serialize(it) ?: return ApiResult.Refused("body_invalid") }
        if (bodyText != null && bodyText.toByteArray().size > MAX_BODY) return ApiResult.Refused("body_invalid")

        val record = installIds.get(orgId)
        val registration = method == "POST" && path == DEVICES_PATH
        if (registration) {
            val o = (body as? JSONObject) ?: return ApiResult.Refused("body_invalid")
            if (record == null || o.opt("install_id") != record.installId) return ApiResult.Refused("body_install_id")
            if (o.opt("device_key") != deviceKeys.publicKey(orgId)) return ApiResult.Refused("body_device_key")
        }
        val session = try {
            sessions.status(orgUrl.removePrefix("https://"), now())
        } catch (e: VaultLockedException) {
            null
        } ?: return ApiResult.SessionExpired
        val value = CookieSpec.value(session.jwt, session.cookie, session.credentialKind) ?: return ApiResult.SessionExpired
        val headers = linkedMapOf("Cookie" to "CF_Authorization=$value", "cf-access-token" to session.jwt)
        if (record != null && (registration || record.registered)) headers["Yaran-Install-Id"] = record.installId
        val result = send(URL("$orgUrl$path"), method, bodyText, headers, credentialed = true, orgId = orgId)
        if (registration && result is ApiResult.Ok) installIds.markRegistered(orgId)
        return result
    }

    private fun send(url: URL, method: String, body: String?, headers: Map<String, String>, credentialed: Boolean, orgId: String?): ApiResult {
        val conn = connect(url)
        try {
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.requestMethod = method
            conn.setRequestProperty("User-Agent", userAgent)
            conn.setRequestProperty("Yaran-Protocol", PROTOCOL)
            conn.setRequestProperty("Accept", "application/json")
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val bytes = stream?.use { readCapped(it) } ?: ByteArray(0)
            if (bytes.size > MAX_RESPONSE) return ApiResult.Refused("response_too_large")
            return classify(status, conn.contentType, String(bytes, Charsets.UTF_8), credentialed, orgId)
        } catch (e: SSLException) {
            diagnostics.append("machine-view org api tls error host=${url.host}")
            return ApiResult.TlsError
        } catch (e: IOException) {
            diagnostics.append("machine-view org api offline host=${url.host} (${e.javaClass.simpleName})")
            return ApiResult.Offline
        } finally {
            conn.disconnect()
        }
    }

    private fun classify(status: Int, contentType: String?, text: String, credentialed: Boolean, orgId: String?): ApiResult {
        if (status in 200..299) {
            if (text.isEmpty()) return ApiResult.Ok(status, null)
            if (contentType?.lowercase()?.contains("json") != true || !isJson(text)) return ApiResult.Refused("not_json")
            return ApiResult.Ok(status, text)
        }
        val envelope = envelope(text)
        if (envelope == null) {
            if (credentialed && (status in 300..399 || status == 401 || status == 403)) return ApiResult.SessionExpired
            return ApiResult.ApiError(status, synthesized(status))
        }
        val error = envelope.getJSONObject("error")
        when (error.getString("code")) {
            "device_revoked" -> if (status == 403 && orgId != null) {
                diagnostics.append("machine-view org api device_revoked: wiping this org's sessions and device identity")
                wipeOrg(orgId)
                return ApiResult.DeviceRevoked
            }
            "protocol_unsupported" -> {
                val d = error.optJSONObject("details")
                return ApiResult.ProtocolUnsupported(d?.opt("min") as? Int, d?.opt("max") as? Int)
            }
        }
        diagnostics.append("machine-view org api error status=$status code=${error.getString("code")}")
        return ApiResult.ApiError(status, text)
    }

    private fun envelope(text: String): JSONObject? = try {
        val o = JSONObject(text)
        val e = o.getJSONObject("error")
        // The schema pattern is checked here, so the code is safe to log and to switch on.
        if ((e.opt("code") as? String)?.let { CODE_RE.matches(it) } == true && e.opt("message") is String && e.opt("retryable") is Boolean && o.opt("request_id") is String) o else null
    } catch (e: JSONException) {
        null
    }

    private fun synthesized(status: Int): String = JSONObject()
        .put("error", JSONObject().put("code", if (status < 500) "bad_request" else "unavailable")
            .put("message", "The server answered HTTP $status with no error details.").put("retryable", status >= 500))
        .put("request_id", "-").toString()

    private fun isJson(text: String): Boolean = try {
        val t = JSONTokener(text)
        t.nextValue()
        t.nextClean() == 0.toChar()
    } catch (e: JSONException) {
        false
    }

    private fun serialize(body: Any): String? = when (body) {
        is JSONObject, is org.json.JSONArray -> body.toString()
        is String -> JSONObject.quote(body)
        is Number, is Boolean -> body.toString()
        else -> null
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
        const val META_PATH = "/v1/meta"
        const val DEVICES_PATH = "/v1/me/devices"
        const val PROTOCOL = "1"
        const val TIMEOUT_MS = 15_000
        private val CODE_RE = Regex("^[a-z][a-z0-9_]{0,63}$")
        const val MAX_RESPONSE = 1 shl 20
        const val MAX_BODY = 64 * 1024
        val METHODS = setOf("GET", "POST", "PATCH", "DELETE")
        private val PATH = Regex("^/v1/[A-Za-z0-9/_.~%-]*(?:\\?[A-Za-z0-9=&_.~%-]*)?$")

        fun pathOk(path: String): Boolean {
            if (!PATH.matches(path)) return false
            val segments = path.substringBefore('?').split('/').drop(1)
            return segments.dropLast(1).none { it.isEmpty() } && segments.none { it == "." || it == ".." }
        }
    }
}
