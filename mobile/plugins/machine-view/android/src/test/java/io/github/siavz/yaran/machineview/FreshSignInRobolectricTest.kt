/**
 * FreshSignInRobolectricTest: the window's own fresh sign-in never outweighs a known instance
 * mismatch (Sol native review round 11).
 *
 * A direct window with no recorded instance signs in at instance i1 and loads with that session.
 * The machine then answers as i2. The document probe chooses again; the i1 record and its cookie
 * go, nothing loads with the i1 token, and the password is asked for. Instance ids are public:
 * this is consistency, not authorization. Every request goes to a loopback stand-in.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.FreshSignInRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.app, android.content, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.AlertDialog
import android.content.Intent
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.EditText
import androidx.test.core.app.ApplicationProvider
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlertDialog
import java.net.URL
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class FreshSignInRobolectricTest {
    private val vault = TestBindings.vault
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()

    /** The instance the machine answers as; it knows only the session its own instance issued. */
    @Volatile private var instance = "i1"
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.endsWith("/cli-login") -> json(JSONObject().put("token", "tokA").put("expires_at", JSONObject.NULL)
                    .put("cookie_name", "yaran_session_443"))
                request.path!!.endsWith("/cli-logout") -> MockResponse().setResponseCode(204)
                else -> json(FakeYaran.capableStatus().put("instance", instance).put("password_set", true).put("required_here", true)
                    .put("signed_in", instance == "i1" && request.getHeader("Cookie") == "yaran_session_443=tokA"))
            }
        }
        start()
    }

    private fun json(o: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(o.toString())

    @Before
    fun bindings() {
        TestBindings.lock.apply {
            enabled = false
            locked = false
        }
        vault.apply {
            data.clear()
            classes.clear()
            locked = false
        }
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { "https://cp.example.com" }, TestBindings.lock, { false }))
        rt.directAuth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
            (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply { sslSocketFactory = trust.sslSocketFactory() }
        }
        CookieManager.getInstance().removeAllCookies(null)
        ShadowAlertDialog.reset()
    }

    @After
    fun stop() = server.shutdown()

    private companion object {
        const val A = "a.example.com"
        const val PAGE = "https://$A/"
    }

    private fun drainIo() {
        repeat(8) {
            rt.io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun views(g: ViewGroup): List<android.view.View> =
        (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + views(it) else listOf(it) }

    private fun loads(w: MachineViewActivity) =
        views(w.window.decorView as ViewGroup).filterIsInstance<WebView>().flatMap { Shadow.extract<PauseShadowWebView>(it).loads }

    private fun cookie() = CookieManager.getInstance().getCookie(PAGE).orEmpty()

    @Test
    fun aFreshSignInNeverOutweighsAKnownInstanceMismatch() {
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
            .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).toString()) // no recorded instance
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        drainIo()
        val sheet = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        views(shadowOf(sheet).view as ViewGroup).filterIsInstance<EditText>().single().setText("hunter2")
        sheet.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        drainIo()
        assertEquals("signed in at i1 and loaded", listOf(PAGE), loads(w))
        assertEquals("tokA", rt.directSessions.get(A)?.token)
        assertTrue(cookie().contains("tokA"))
        assertTrue(w.admitDocument(PAGE)) // that load's own document

        instance = "i2" // the machine at A is another yaran now
        assertFalse("the reload is refused", w.admitDocument(PAGE))
        drainIo()
        assertNull("the i1 record is gone, fresh sign-in or not", rt.directSessions.get(A))
        assertFalse("and its cookie", cookie().contains("tokA"))
        assertEquals("nothing loaded with the i1 token", listOf(PAGE), loads(w))
        val again = ShadowAlertDialog.getLatestAlertDialog()
        assertNotSame("the password is asked for", sheet, again)
        assertEquals("Sign in to $A", shadowOf(again).title)
    }
}
