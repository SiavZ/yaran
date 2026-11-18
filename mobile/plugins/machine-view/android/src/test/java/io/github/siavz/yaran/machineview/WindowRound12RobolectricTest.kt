/**
 * WindowRound12RobolectricTest: the direct window's resume, sign-in and cookie steps against a
 * machine that changes under it (Sol native review round 12), through the real window over a
 * loopback HTTPS stand-in.
 *
 * A resume that keeps the route reads the session (and drops a stale instance's record and cookie)
 * before it asks for a password, and asks for none when the window's fresh session still covers an
 * instance-less machine. A lone direct window recorded for i1 that finds i2 closes `instance_changed`.
 * Overlapping password asks put up one sheet, gone with the window. A cookie queued for a window that
 * closed or was replaced before it ran is never set.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.WindowRound12RobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.app, android.content, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, java.util.concurrent, java.util.concurrent.atomic, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.android.controller, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.AlertDialog
import android.content.Intent
import android.os.Looper
import android.os.SystemClock
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowDialog
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class WindowRound12RobolectricTest {
    private val vault = TestBindings.vault
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()

    /** The instance the machine answers as (null: none); it knows the session only of the instance that issued it. */
    @Volatile private var instance: String? = "i1"
    @Volatile private var issuedFor: String? = null
    private val logins = AtomicInteger()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when {
                request.path!!.endsWith("/cli-login") -> {
                    logins.incrementAndGet()
                    issuedFor = instance
                    json(JSONObject().put("token", "tokA").put("expires_at", JSONObject.NULL).put("cookie_name", "yaran_session_443"))
                }
                request.path!!.endsWith("/cli-logout") -> MockResponse().setResponseCode(204)
                else -> json(FakeYaran.capableStatus().put("instance", instance ?: JSONObject.NULL).put("password_set", true)
                    .put("required_here", true).put("signed_in", request.getHeader("Cookie") == "yaran_session_443=tokA" && issuedFor == instance))
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

    private fun window(recorded: String? = null) = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
        .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).toString())
        .apply { recorded?.let { putExtra("instance", it) } }

    private fun sheets() = ShadowDialog.getShownDialogs().filterIsInstance<AlertDialog>().filter { it.isShowing }

    /** Opens the window and signs in through its sheet: one load, with the session's cookie. */
    private fun signedIn(recorded: String? = null): ActivityController<MachineViewActivity> {
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window(recorded)).setup()
        drainIo()
        val sheet = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        views(shadowOf(sheet).view as ViewGroup).filterIsInstance<EditText>().single().setText("hunter2")
        sheet.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        drainIo()
        assertEquals(listOf(PAGE), loads(ctl.get()))
        assertTrue(ctl.get().admitDocument(PAGE)) // that load's own document
        return ctl
    }

    private fun awayAndBack(ctl: ActivityController<MachineViewActivity>) {
        ctl.pause()
        ctl.get().pausedAt = SystemClock.elapsedRealtime() - MachineViewActivity.PARKED_MS - 1
        ctl.resume()
        drainIo()
    }

    // Finding 1: no recorded instance, signed in at i1, away long enough, back to i2. The kept
    // route's resume reads the session first: the i1 record and cookie are gone before the password is asked.
    @Test
    fun aResumeThatFindsAnotherInstanceDropsTheOldSessionBeforeTheSheet() {
        val ctl = signedIn()
        assertTrue(cookie().contains("tokA"))
        val before = ShadowAlertDialog.getLatestAlertDialog()
        instance = "i2"
        awayAndBack(ctl)
        assertNull("the i1 record is gone", rt.directSessions.get(A))
        assertFalse("and its cookie", cookie().contains("tokA"))
        assertTrue("then the password is asked", ShadowAlertDialog.getLatestAlertDialog() !== before)
        assertEquals("nothing more loaded", listOf(PAGE), loads(ctl.get()))
    }

    // Finding 1: an instance-less machine, signed in by this window, away and back: the window's
    // fresh session still covers it, so no second password and the cookie is put back.
    @Test
    fun anInstanceLessMachinesFreshSessionAsksForNoSecondPassword() {
        instance = null
        val ctl = signedIn()
        val before = ShadowAlertDialog.getLatestAlertDialog()
        CookieManager.getInstance().removeAllCookies(null)
        awayAndBack(ctl)
        assertTrue("no second sheet", ShadowAlertDialog.getLatestAlertDialog() === before)
        assertEquals(1, logins.get())
        assertTrue("the session's cookie is back", cookie().contains("tokA"))
    }

    // Finding 3: a lone direct window recorded for i1 finds i2 after a long background: that is
    // another machine, not an offline one. It closes instance_changed with its host; nothing loads.
    @Test
    fun aRecordedInstanceThatChangedClosesTheWindowAtResume() {
        val ctl = signedIn(recorded = "i1")
        instance = "i2"
        awayAndBack(ctl)
        assertEquals("instance_changed", ctl.get().closedWith!!["code"])
        assertEquals(A, ctl.get().closedWith!!["host"])
        assertEquals(listOf(PAGE), loads(ctl.get()))
    }

    /** Opens the window, cancels its first sheet, then asks twice before either preflight answered. */
    private fun twoAsks(): ActivityController<MachineViewActivity> {
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window()).setup()
        drainIo()
        (ShadowAlertDialog.getLatestAlertDialog() as AlertDialog).getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(0, sheets().size)
        ctl.get().routes.directSignIn()
        ctl.get().routes.directSignIn()
        drainIo()
        assertEquals("one sheet for the two asks", 1, sheets().size)
        return ctl
    }

    // Finding 4: the one sheet goes with the window, and nothing is posted.
    @Test
    fun overlappingPasswordAsksPutUpOneSheetThatGoesWithTheWindow() {
        val ctl = twoAsks()
        ctl.get().close("user", null)
        drainIo()
        assertEquals("no sheet left behind", 0, sheets().size)
        assertEquals("nothing posted", 0, logins.get())
    }

    // Finding 4: a new open replaces the window: the old sheet goes, and the new open's own ask is
    // not blocked by the old reservation and signs in normally.
    @Test
    fun overlappingPasswordAsksDoNotBlockTheNextOpen() {
        val ctl = twoAsks()
        val old = sheets().single()
        ctl.newIntent(window())
        drainIo()
        assertFalse("the old sheet is gone", old.isShowing)
        val next = sheets().single()
        views(shadowOf(next).view as ViewGroup).filterIsInstance<EditText>().single().setText("hunter2")
        next.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        drainIo()
        assertEquals("one sign-in, the new open's", 1, logins.get())
        assertTrue(cookie().contains("tokA"))
    }

    // Finding 5: a cookie queued for this window's load runs after the window closed: not set.
    @Test
    fun aCookieQueuedForAClosedWindowIsNeverSet() {
        val ctl = signedIn()
        val w = ctl.get()
        CookieManager.getInstance().removeAllCookies(null)
        w.admitted = w.openGen
        w.load(PAGE) // queues the cookie on the main thread
        w.close("user", null)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(cookie().contains("tokA"))
        assertEquals("nor anything loaded", listOf(PAGE), loads(w))
    }

    // Finding 5: the same with the window replaced by another open before the queued cookie ran.
    @Test
    fun aCookieQueuedForAReplacedOpenIsNeverSet() {
        val ctl = signedIn()
        val w = ctl.get()
        CookieManager.getInstance().removeAllCookies(null)
        w.routes.reinject() // reads the session, then queues its cookie
        rt.io.submit {}.get()
        shadowOf(Looper.getMainLooper()).runOneTask() // the read's answer queues the cookie
        ctl.newIntent(window()) // a new open of the window before the queued cookie runs
        shadowOf(Looper.getMainLooper()).runOneTask()
        assertFalse(cookie().contains("tokA"))
    }

    // Finding 5 (its clear twin): a stale record dropped for an open that is replaced before the
    // queued cookie clear runs leaves the jar alone; it may be the new open's by then.
    @Test
    fun aStaleDropQueuedForAReplacedOpenClearsNothing() {
        val ctl = signedIn()
        val w = ctl.get()
        rt.directSessions.put(DirectSession(A, "tokOld", "yaran_session_443", "i0", 0, null))
        assertNull("the i0 record is not this open's", w.routes.directReader(w.openGen)(A)) // deletes it, queues the clear
        assertNull(rt.directSessions.get(A))
        ctl.newIntent(window()) // the open moves on before the queued clear runs
        drainIo()
        assertTrue("the jar is left as it was", cookie().contains("tokA"))
    }

    @Test
    fun aClosedWindowsQueuedClearCannotEraseTheNextOwnersCookie() {
        val ctl = signedIn()
        val w = ctl.get()
        rt.cookies.inject(A, "yaran_session_443=tokB; Path=/; Secure; HttpOnly; SameSite=Strict", owned = { true }) {}
        rt.directSessions.put(DirectSession(A, "tokOld", "yaran_session_443", "i0", 0, null))
        assertNull(w.routes.directReader(w.openGen)(A))
        w.close("user", null)
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue("the next owner's cookie survives the closed window's queued clear", cookie().contains("tokB"))
    }

    @Test
    fun aClosedWindowsQueuedReinjectionCannotDeleteTheHostRecord() {
        val ctl = signedIn()
        val w = ctl.get()
        rt.directSessions.put(DirectSession(A, "tokNext", "yaran_session_443", "i2", 0, null))
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        rt.io.execute { entered.countDown(); release.await() }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            w.routes.reinject()
            w.close("user", null)
        } finally {
            release.countDown()
        }
        drainIo()
        assertEquals("the closed queued reader leaves the current record alone", "tokNext", rt.directSessions.get(A)?.token)
    }
}
