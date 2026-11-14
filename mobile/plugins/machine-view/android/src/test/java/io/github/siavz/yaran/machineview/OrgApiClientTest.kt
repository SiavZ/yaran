/**
 * The native org API client against a local HTTPS server (work item 6, D22).
 *
 * Both credential headers, the UA token and protocol header; `Yaran-Install-Id` absent before
 * registration, present on it and after; a foreign install id or device key refused with no
 * request; `device_revoked` wiping exactly that org; redirect refusal; every `ApiResult`
 * variant; the size cap; path, method and origin refusals; offline and TLS failures.
 *
 * - MockWebServer with a HeldCertificate; the client only ever builds org-origin URLs, which
 *   the test connection factory points at the local server.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.OrgApiClientTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: java.net, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URL
import javax.net.ssl.HttpsURLConnection

class OrgApiClientTest {
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val backend = SoftwareKeyBackend()
    private val installIds = InstallIdStore(vault)
    private val keys = DeviceKeyStore(backend, installIds, diag)
    private val sessions = SessionStore(vault, FakeLock(), diag) { }
    private val urls = mutableListOf<URL>()
    private val wiped = mutableListOf<String>()
    private val orgs = OrgDirectory { mapOf("org1" to "https://cp.example.com", "org2" to "https://cp2.example.com", "bad" to "http://x.example.com")[it] }
    private val now = 1_731_571_200L

    private val client = OrgApiClient(orgs, sessions, installIds, keys, { wiped += it; sessions.signOut(it, emptyList()); keys.delete(it) },
        "YaranApp/1.2.3 (android; phone)", { now }, diag) { url ->
        urls += url
        (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply {
            sslSocketFactory = trust.sslSocketFactory()
        }
    }

    @After
    fun stop() = server.shutdown()

    private fun signIn(org: String = "org1", host: String = "cp.example.com", exp: Long = now + 3600) =
        sessions.put(org, HandoffPayload("control_plane", host, TestSealer.jwt(exp), "ada@example.org", exp, now, null))

    private fun json(code: Int, body: String) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    private fun envelope(code: String) = """{"error":{"code":"$code","message":"m","retryable":false},"request_id":"r1"}"""

    @Test
    fun okSendsBothCredentialsAndTheUaToken() {
        signIn()
        server.enqueue(json(200, """{"machines":[]}"""))
        assertEquals(ApiResult.Ok(200, """{"machines":[]}"""), client.request("org1", "GET", "/v1/machines", null))
        val r = server.takeRequest()
        val jwt = TestSealer.jwt(now + 3600)
        assertEquals("CF_Authorization=$jwt", r.getHeader("Cookie"))
        assertEquals(jwt, r.getHeader("cf-access-token"))
        assertEquals("YaranApp/1.2.3 (android; phone)", r.getHeader("User-Agent"))
        assertEquals("1", r.getHeader("Yaran-Protocol"))
        assertNull(r.getHeader("Yaran-Install-Id"))
        assertEquals("cp.example.com", urls.single().host)
    }

    @Test
    fun registrationRulesAndInstallIdHeader() {
        signIn()
        val id = keys.ensure("org1")
        val body = JSONObject().put("install_id", id.installId).put("device_key", id.publicKey)
        assertEquals(ApiResult.Refused("body_install_id"), client.request("org1", "POST", "/v1/me/devices", JSONObject(body.toString()).put("install_id", "00000000-0000-4000-8000-000000000000")))
        val other = keys.ensure("org2").publicKey
        assertEquals(ApiResult.Refused("body_device_key"), client.request("org1", "POST", "/v1/me/devices", JSONObject(body.toString()).put("device_key", other)))
        assertEquals(0, server.requestCount)
        server.enqueue(json(200, "{}"))
        assertTrue(client.request("org1", "POST", "/v1/me/devices", body) is ApiResult.Ok)
        assertEquals(id.installId, server.takeRequest().getHeader("Yaran-Install-Id"))
        assertTrue(installIds.get("org1")!!.registered)
        server.enqueue(json(200, "{}"))
        client.request("org1", "GET", "/v1/me/devices", null)
        assertEquals(id.installId, server.takeRequest().getHeader("Yaran-Install-Id"))
    }

    @Test
    fun deviceRevokedWipesExactlyThatOrg() {
        signIn()
        signIn("org2", "cp2.example.com")
        keys.ensure("org1")
        keys.ensure("org2")
        server.enqueue(json(403, envelope("device_revoked")))
        assertEquals(ApiResult.DeviceRevoked, client.request("org1", "GET", "/v1/me", null))
        assertEquals(listOf("org1"), wiped)
        assertNull(sessions.get("cp.example.com"))
        assertNull(installIds.get("org1"))
        assertTrue(sessions.get("cp2.example.com") != null)
        assertTrue(installIds.get("org2") != null)
    }

    @Test
    fun apiResultVariants() {
        signIn()
        server.enqueue(json(404, envelope("not_found")))
        assertEquals(ApiResult.ApiError(404, envelope("not_found")), client.request("org1", "GET", "/v1/machines/x", null))
        server.enqueue(json(400, """{"error":{"code":"protocol_unsupported","message":"m","retryable":false,"details":{"min":2,"max":3}},"request_id":"r"}"""))
        assertEquals(ApiResult.ProtocolUnsupported(2, 3), client.request("org1", "GET", "/v1/me", null))
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://team.cloudflareaccess.com/"))
        assertEquals(ApiResult.SessionExpired, client.request("org1", "GET", "/v1/me", null))
        server.enqueue(MockResponse().setResponseCode(401).setBody("<html>"))
        assertEquals(ApiResult.SessionExpired, client.request("org1", "GET", "/v1/me", null))
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>"))
        val e = client.request("org1", "GET", "/v1/me", null) as ApiResult.ApiError
        assertEquals("unavailable", JSONObject(e.envelopeJson).getJSONObject("error").getString("code"))
        server.enqueue(MockResponse().setResponseCode(200).setHeader("Content-Type", "text/html").setBody("<html>"))
        assertEquals(ApiResult.Refused("not_json"), client.request("org1", "GET", "/v1/me", null))
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(ApiResult.Ok(204, null), client.request("org1", "DELETE", "/v1/me/devices/abc", null))
        server.enqueue(json(200, "\"" + "a".repeat(OrgApiClient.MAX_RESPONSE + 10) + "\""))
        assertEquals(ApiResult.Refused("response_too_large"), client.request("org1", "GET", "/v1/me", null))
        // A code outside the schema pattern is no envelope, so it never reaches diagnostics.
        server.enqueue(json(500, envelope("\u001b[31mEVIL")))
        val forged = client.request("org1", "GET", "/v1/me", null) as ApiResult.ApiError
        assertEquals("unavailable", JSONObject(forged.envelopeJson).getJSONObject("error").getString("code"))
        assertTrue(diag.lines.none { "EVIL" in it })
    }

    @Test
    fun refusalsWithoutARequest() {
        signIn()
        assertEquals(ApiResult.Refused("unknown_org"), client.request("nope", "GET", "/v1/me", null))
        assertEquals(ApiResult.Refused("origin"), client.request("bad", "GET", "/v1/me", null))
        assertEquals(ApiResult.Refused("method"), client.request("org1", "PUT", "/v1/me", null))
        for (p in listOf("/v2/me", "/v1/../admin", "/v1//me", "/v1/./me", "v1/me", "/v1/me#x", "/v1/me x", "https://evil/v1/me")) {
            assertEquals(p, ApiResult.Refused("path"), client.request("org1", "GET", p, null))
        }
        assertEquals(0, server.requestCount)
    }

    @Test
    fun expiredOrMissingSessionNeedsNoRequest() {
        assertEquals(ApiResult.SessionExpired, client.request("org1", "GET", "/v1/me", null))
        signIn(exp = now)
        assertEquals(ApiResult.SessionExpired, client.request("org1", "GET", "/v1/me", null))
        assertEquals(0, server.requestCount)
    }

    @Test
    fun metaHasNoCredentialsAndOnlyItsPath() {
        server.enqueue(json(200, """{"name":"Ada"}"""))
        assertTrue(client.meta("https://cp.example.com") is ApiResult.Ok)
        val r = server.takeRequest()
        assertEquals("/v1/meta", r.path)
        assertNull(r.getHeader("Cookie"))
        assertNull(r.getHeader("cf-access-token"))
        assertEquals(ApiResult.Refused("origin"), client.meta("https://cp.example.com/evil"))
    }

    @Test
    fun offlineAndTls() {
        signIn()
        val offline = OrgApiClient(orgs, sessions, installIds, keys, {}, "ua", { now }, diag) {
            URL("https", "localhost", 1, it.file).openConnection() as HttpsURLConnection
        }
        assertEquals(ApiResult.Offline, offline.request("org1", "GET", "/v1/me", null))
        val untrusted = OrgApiClient(orgs, sessions, installIds, keys, {}, "ua", { now }, diag) {
            URL("https", "localhost", server.port, it.file).openConnection() as HttpsURLConnection
        }
        server.enqueue(json(200, "{}"))
        assertEquals(ApiResult.TlsError, untrusted.request("org1", "GET", "/v1/me", null))
        assertTrue(diag.lines.none { it.contains("eyJ") })
    }
}
