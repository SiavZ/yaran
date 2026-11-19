/**
 * DirectAuthTest: the direct client over real HTTPS (MockWebServer): redirects are never
 * followed, a stored session is attached only to its own host and only after an open answer
 * proved the same instance, the password goes only in the login body, a token the phone did
 * not keep is revoked, and sign-out sends the bearer to `cli-logout`.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DirectAuthTest
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * └── io.github.siavz.yaran.machineview.Fakes (inferred)
 * External: java.net, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert
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
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

class DirectAuthTest {
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val urls = mutableListOf<URL>()
    private val auth = DirectAuth("YaranApp/1.2.3 (android; phone)", FakeDiagnostics()) { url ->
        urls += url
        (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply { sslSocketFactory = trust.sslSocketFactory() }
    }
    private val host = "yaran.example.com"

    @After
    fun stop() = server.shutdown()

    private fun status(instance: String?, signedIn: Boolean = false) = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("password_set", true).put("required_here", true).put("signed_in", signedIn).put("client_class", "network")
            .put("transport_encrypted", true).put("native_auth_ui", true).put("instance", instance ?: JSONObject.NULL).toString())

    @Test
    fun aRedirectIsClassifiedAndNeverFollowed() {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login/x"))
        server.enqueue(status("i1")) // would answer a followed redirect
        assertEquals(DirectStatus.AccessRequired, auth.status(host, null))
        assertEquals(1, server.requestCount)
        assertEquals(listOf("https://$host/api/v1/auth/status"), urls.map { it.toString() })
    }

    @Test
    fun theSessionGoesOnlyToItsOwnHostAndOnlyAfterTheSameInstanceAnswered() {
        val session = DirectSession(host, "tok_1", "yaran_session_443", "i1", 1)
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        assertEquals(DirectStatus.Yaran("i1", true, true, true, true), auth.status(host, session))
        assertNull("the first request carries nothing", server.takeRequest().getHeader("Cookie"))
        assertEquals("yaran_session_443=tok_1", server.takeRequest().getHeader("Cookie"))

        server.enqueue(status("someone-else"))
        assertEquals(DirectStatus.Yaran("someone-else", true, true, false, true), auth.status(host, session))
        assertNull(server.takeRequest().getHeader("Cookie"))
        assertNull("another instance never sees the token", server.takeRequest(200, TimeUnit.MILLISECONDS))

        server.enqueue(status("i1"))
        auth.status(host, DirectSession("other.example.com", "tok_1", "yaran_session_443", "i1", 1))
        assertNull(server.takeRequest().getHeader("Cookie"))
        assertNull("a session for another host is never attached", server.takeRequest(200, TimeUnit.MILLISECONDS))

        assertEquals(DirectStatus.Refused("invalid_host"), auth.status("10.0.0.2", session))
        assertEquals(DirectStatus.Refused("invalid_host"), auth.status("yaran.example.com:8443", session))
    }

    @Test
    fun theLoginPostsOnlyTheBodyAndRevokesATokenThePhoneCannotUse() {
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"token":"tok_9","expires_at":null,"cookie_name":"yaran_session_443"}"""))
        val answer = auth.login(host, DirectWire.loginBody("hunter2".toCharArray(), "yaran phone (Pixel)"))
        assertTrue(answer is LoginAnswer.Token)
        val r = server.takeRequest()
        assertEquals("POST", r.method)
        assertEquals("/api/v1/auth/cli-login", r.path)
        assertNull(r.getHeader("Cookie"))
        assertNull(r.getHeader("Authorization"))
        assertEquals("hunter2", JSONObject(r.body.readUtf8()).getString("password"))

        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"token":"tok_old","expires_at":null}"""))
        server.enqueue(MockResponse().setResponseCode(204))
        val old = auth.login(host, DirectWire.loginBody("x".toCharArray(), "l"))
        assertEquals(DirectSignInOutcome.ServerRefused(200, "cookie_name_missing", ""), (old as LoginAnswer.Failed).outcome)
        server.takeRequest()
        val revoke = server.takeRequest()
        assertEquals("/api/v1/auth/cli-logout", revoke.path)
        assertEquals("Bearer tok_old", revoke.getHeader("Authorization"))

        server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", "https://evil.example.com/steal"))
        assertEquals(DirectSignInOutcome.Redirected, (auth.login(host, DirectWire.loginBody("x".toCharArray(), "l")) as LoginAnswer.Failed).outcome)
        assertEquals(4, server.requestCount)
    }

    @Test
    fun signOutEndsTheBearerOnTheMachine() {
        server.enqueue(MockResponse().setResponseCode(204))
        assertTrue(auth.logout(host, "tok_1"))
        assertEquals("Bearer tok_1", server.takeRequest().getHeader("Authorization"))
        server.enqueue(MockResponse().setResponseCode(401))
        assertEquals(false, auth.logout(host, "tok_1"))
        assertEquals(false, auth.logout(host, "bad token"))
        assertEquals(2, server.requestCount)
    }

    @Test
    fun anUnreachableHostIsOffline() {
        server.shutdown()
        assertEquals(DirectStatus.Offline, auth.status(host, null))
    }
}
