/**
 * The publisher push relay client for the G5 fallback: R1 `GET /v1/meta` and R2
 * `POST /v1/endpoints` with 02's `FcmMintRequest` (`kind: "fcm"`).
 *
 * Checks that the relay serves this application id on the `fcm` channel, then mints the
 * per-org endpoint. The relay holds no user credential, so this is the one native call that
 * does not go through Phase 15's org client.
 *
 * - The base URL is a build-time setting and must be HTTPS; anything else is refused before a
 *   request is made. Only a 02 error code is kept from a relay answer, never its body text.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.relay.RelayEndpointClient
 * └── io.github.siavz.yaran.push.relay.RelayFcmTest (inferred)
 * External: java.io, java.net, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.relay.RelayEndpointClient
 * ├── io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.relay.RelayFcmTest (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.relay

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

sealed class RelayError(message: String) : Exception(message) {
    object InsecureBaseUrl : RelayError("the push relay address is not HTTPS")
    object NotYaranRelay : RelayError("the push relay address does not answer as a yaran relay")
    object AppNotServed : RelayError("the push relay does not serve this app")
    object ChannelNotServed : RelayError("the push relay does not deliver through FCM")
    data class RateLimited(val retryAfter: Int?) : RelayError("the push relay is busy; retry in ${retryAfter ?: 60} seconds")
    data class Unavailable(val status: Int) : RelayError("the push relay is unavailable (HTTP $status)")
    data class Api(val status: Int, val code: String) : RelayError("the push relay refused the registration ($code)")
    object Malformed : RelayError("the push relay sent an unreadable answer")
    object Network : RelayError("the push relay is unreachable")
}

data class HttpResponse(val status: Int, val retryAfter: String?, val body: String)

/** The one HTTP call shape the client needs; the tests swap it. */
fun interface RelayTransport {
    fun send(method: String, url: URL, body: String?): HttpResponse
}

class RelayEndpointClient(baseUrl: String, private val appId: String, private val transport: RelayTransport = UrlConnectionTransport) {
    private val base: URL = URL(baseUrl.trimEnd('/')).also { if (it.protocol != "https" || it.host.isNullOrEmpty()) throw RelayError.InsecureBaseUrl }

    /** R1: the relay's `endpoint_key_id` once this app and `channel` are served. */
    fun endpointKeyId(channel: String = "fcm"): String {
        val o = send("GET", "/v1/meta", null, expect = 200)
        if (o.optString("service") != "yaran-push-relay") throw RelayError.NotYaranRelay
        val apps = o.optJSONArray("apps") ?: throw RelayError.NotYaranRelay
        val channels = o.optJSONArray("channels") ?: throw RelayError.NotYaranRelay
        val kid = o.optString("endpoint_key_id").ifEmpty { throw RelayError.NotYaranRelay }
        if ((0 until apps.length()).none { apps.optString(it) == appId }) throw RelayError.AppNotServed
        if ((0 until channels.length()).none { channels.optString(it) == channel }) throw RelayError.ChannelNotServed
        return kid
    }

    /** 02 `FcmMintRequest`, as sent. */
    fun fcmMintBody(fcmToken: String, vapidPublicKey: String, registrationId: String): JSONObject = JSONObject()
        .put("kind", "fcm").put("app_id", appId).put("fcm_token", fcmToken)
        .put("vapid_public_key", vapidPublicKey).put("registration_id", registrationId)

    /** R2: one endpoint, a capability that stays in native code. */
    fun mint(body: JSONObject): String {
        val endpoint = send("POST", "/v1/endpoints", body.toString(), expect = 201).optString("endpoint")
        if (!ENDPOINT.matches(endpoint)) throw RelayError.Malformed
        return endpoint
    }

    private fun send(method: String, path: String, body: String?, expect: Int): JSONObject {
        val r = try {
            transport.send(method, URL(base, base.path + path), body)
        } catch (_: IOException) {
            throw RelayError.Network
        }
        val json = runCatching { JSONObject(r.body.take(64 * 1024)) }.getOrNull()
        return when {
            r.status == expect -> json ?: throw RelayError.Malformed
            r.status == 429 -> throw RelayError.RateLimited(r.retryAfter?.toIntOrNull())
            r.status == 503 -> throw RelayError.Unavailable(r.status)
            else -> {
                val code = json?.optJSONObject("error")?.optString("code")?.takeIf { CODE.matches(it) }
                if (code != null) throw RelayError.Api(r.status, code)
                if (r.status >= 500) throw RelayError.Unavailable(r.status)
                throw RelayError.Malformed
            }
        }
    }

    companion object {
        private val ENDPOINT = Regex("https://[^/]+/w/v1\\.[A-Za-z0-9_-]{1,16}\\.[A-Za-z0-9_-]{16,1024}")
        private val CODE = Regex("[a-z_]{1,64}")
    }
}

object UrlConnectionTransport : RelayTransport {
    override fun send(method: String, url: URL, body: String?): HttpResponse {
        val c = url.openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.instanceFollowRedirects = false
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.setRequestProperty("Accept", "application/json")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status >= 400) c.errorStream else c.inputStream
            val text = stream?.use { it.readBytes().take(64 * 1024).toByteArray().toString(Charsets.UTF_8) }.orEmpty()
            return HttpResponse(status, c.getHeaderField("Retry-After"), text)
        } finally {
            c.disconnect()
        }
    }
}
