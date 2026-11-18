/**
 * AbandonedLoginRobolectricTest: a password sign-in whose window closed or was replaced while
 * `cli-login` was on the wire keeps nothing (Sol native review round 8).
 *
 * The machine (a loopback stand-in) holds the login answer until the test lets it go. Once it
 * answers, the window that asked is gone: the token it got is revoked on the machine, nothing is
 * stored, and a session that is current for the host meanwhile is neither replaced nor revoked.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.app, android.content, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, java.util, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadows
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
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog
import java.net.URL
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class AbandonedLoginRobolectricTest {
    private val vault = TestBindings.vault
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val answer = CountDownLatch(1)
    private val revoked: MutableList<String?> = Collections.synchronizedList(mutableListOf())
    private val logins = CountDownLatch(1)
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.endsWith("/cli-login") -> {
                    logins.countDown()
                    answer.await(10, TimeUnit.SECONDS) // on the wire until the test lets it answer
                    json(JSONObject().put("token", "tokLate").put("expires_at", JSONObject.NULL).put("cookie_name", "yaran_session_443"))
                }
                request.path!!.endsWith("/cli-logout") -> MockResponse().setResponseCode(204).also { revoked += request.getHeader("Authorization") }
                else -> json(FakeYaran.capableStatus().put("instance", "i1").put("password_set", true).put("required_here", true))
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
    fun stop() {
        answer.countDown()
        server.shutdown()
    }

    private companion object {
        const val A = "a.example.com"
    }

    private fun window() = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
        .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).toString()).putExtra("instance", "i1")

    private fun drainIo() {
        repeat(6) {
            rt.io.submit {}.get(15, TimeUnit.SECONDS)
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun views(g: ViewGroup): List<android.view.View> =
        (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + views(it) else listOf(it) }

    /** Opens the window, which asks for the password, and submits one: the login is now on the wire. */
    private fun submitted(): org.robolectric.android.controller.ActivityController<MachineViewActivity> {
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window()).setup()
        drainIo()
        val sheet = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        views(shadowOf(sheet).view as ViewGroup).filterIsInstance<EditText>().single().setText("hunter2")
        sheet.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle() // the click runs: the login goes out on the io thread
        assertEquals("the login is on the wire", true, logins.await(10, TimeUnit.SECONDS))
        return ctl
    }

    @Test
    fun aLoginAnsweredAfterItsWindowClosedKeepsNothing() {
        val ctl = submitted()
        ctl.get().close("user", null)
        answer.countDown()
        drainIo()
        assertNull("nothing stored", rt.directSessions.get(A))
        assertEquals("only the late token is revoked", listOf<String?>("Bearer tokLate"), revoked.toList())
    }

    @Test
    fun aLoginAnsweredAfterItsWindowWasReplacedLeavesTheCurrentSessionAlone() {
        val ctl = submitted()
        ctl.newIntent(window()) // a new open of the same machine replaces the target
        rt.directSessions.put(DirectSession(A, "tokNew", "yaran_session_443", "i1", 2, "idN_nnnnnnnnnnnnnnnnnn")) // current meanwhile
        answer.countDown()
        drainIo()
        assertEquals("the current session stands", "tokNew", rt.directSessions.get(A)?.token)
        assertEquals("only the late token is revoked", listOf<String?>("Bearer tokLate"), revoked.toList())
    }
}
