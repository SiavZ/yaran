/**
 * NativeCookieIsolationRobolectricTest: native HTTP sends only the credential it chose, with
 * Capacitor's real WebView-backed cookie handler installed process-wide (Sol native review round 4).
 *
 * The page's own session for a host sits in the WebView's cookie jar; Capacitor's
 * `CapacitorCookieManager` hands that jar to every `HttpURLConnection`. A direct probe must reach
 * the machine with no Cookie at all, a credentialed status only with the session it attached, an
 * org call only with its own `CF_Authorization`, and nothing a response sets may land in the
 * WebView's jar. Requests outside the native clients still get the handler, unchanged.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.NativeCookieIsolationRobolectricTest
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeHttp (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.webkit, androidx.test.core.app, com.getcapacitor, com.getcapacitor.plugin, java.net, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.webkit.CookieManager
import androidx.test.core.app.ApplicationProvider
import com.getcapacitor.Bridge
import com.getcapacitor.CapConfig
import com.getcapacitor.plugin.CapacitorCookieManager
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.CookieHandler
import java.net.CookiePolicy
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NativeCookieIsolationRobolectricTest {
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val jar get() = CookieManager.getInstance()
    private val origin get() = "https://localhost:${server.port}/"
    private val connect = { url: URL ->
        (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply { sslSocketFactory = trust.sslSocketFactory() }
    }

    /** Exactly what CapacitorCookies.load() installs at every bridge start: the WebView's jar for every connection. */
    private fun capacitorManager(): CapacitorCookieManager {
        val unsafeClass = Class.forName("sun.misc.Unsafe")
        val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        val bridge = unsafeClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, Bridge::class.java) as Bridge
        Bridge::class.java.getDeclaredField("config").apply { isAccessible = true }
            .set(bridge, CapConfig.Builder(ApplicationProvider.getApplicationContext()).create())
        return CapacitorCookieManager(null, CookiePolicy.ACCEPT_ALL, bridge)
    }

    @Before
    fun capacitorsHandler() {
        CookieHandler.setDefault(capacitorManager())
        jar.removeAllCookies(null)
        jar.setCookie(origin, "yaran_session_443=webTok; Path=/; Secure; HttpOnly")
        jar.setCookie(origin, "CF_Authorization=webJwt; Path=/; Secure; HttpOnly")
    }

    @After
    fun stop() {
        CookieHandler.setDefault(null)
        server.shutdown()
    }

    private fun status(instance: String, signedIn: Boolean = false) = MockResponse().setHeader("Content-Type", "application/json")
        .setHeader("Set-Cookie", "planted=1; Path=/; Secure")
        .setBody(JSONObject().put("password_set", true).put("required_here", true).put("signed_in", signedIn).put("client_class", "network")
            .put("transport_encrypted", true).put("native_auth_ui", true).put("instance", instance).toString())

    @Test
    fun theHarnessIsLiveOutsideTheNativeClients() {
        server.enqueue(MockResponse())
        connect(URL("${origin}plain")).inputStream.close()
        assertTrue("Capacitor's handler sends the WebView's cookies", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie")!!.contains("webTok"))
    }

    @Test
    fun aDirectProbeSendsNothingAndACredentialedOneOnlyItsOwnSession() {
        val auth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics(), connect)
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        auth.status("a.example.com", DirectSession("a.example.com", "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        assertNull("the public probe carries no cookie", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        assertEquals("then only the session it attached", "yaran_session_443=tokA", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        assertFalse("nothing a response sets reaches the WebView's jar", jar.getCookie(origin).orEmpty().contains("planted"))
    }

    // Round 5: a bridge starts again (a fresh CapacitorCookieManager installed process-wide) on
    // another thread while a native probe is creating its connection.
    @Test
    fun aBridgeRestartDuringANativeOpenNeverReachesThatConnection() {
        val manager = capacitorManager()
        var bridge: Thread? = null
        val auth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
            if (bridge == null) {
                val installed = CountDownLatch(1)
                // CapacitorCookies.load() installs its handler, then the rest of the bridge start runs on.
                val b = Thread {
                    NativeHttp.frameworkStart {
                        CookieHandler.setDefault(manager)
                        installed.countDown()
                        Thread.sleep(300)
                    }
                }.apply { start() }
                bridge = b
                val until = System.currentTimeMillis() + 2_000
                while (b.state != Thread.State.BLOCKED && installed.count > 0 && System.currentTimeMillis() < until) Thread.sleep(5)
            }
            connect(url)
        }
        server.enqueue(status("i1"))
        auth.status("a.example.com", null)
        bridge!!.join(5_000)
        assertNull("the restart never reached the open connection", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))

        server.enqueue(status("i1"))
        auth.status("a.example.com", null)
        assertNull("nor a later native request", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        server.enqueue(MockResponse())
        connect(URL("${origin}plain")).inputStream.close()
        assertTrue("the new bridge's handler still serves everyone else", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie")!!.contains("webTok"))
    }

    @Test
    fun anOrgCallSendsOnlyItsOwnAccessCookie() {
        val vault = FakeVault()
        val diag = FakeDiagnostics()
        val ids = InstallIdStore(vault)
        val sessions = SessionStore(vault, diag) { }
        val now = 1_731_571_200L
        val jwt = TestSealer.jwt(now + 3600)
        sessions.put("org1", HandoffPayload("control_plane", "cp.example.com", jwt, "ada@example.org", now + 3600, now, null))
        val client = OrgApiClient({ "https://cp.example.com" }, sessions, ids, DeviceKeyStore(SoftwareKeyBackend(), ids, diag), {}, "ua", { now }, diag, connect)
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setHeader("Set-Cookie", "planted=1; Path=/; Secure").setBody("{}"))
        client.request("org1", "GET", "/v1/machines", null)
        assertEquals("CF_Authorization=$jwt", server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        assertFalse(jar.getCookie(origin).orEmpty().contains("planted"))
    }
}
