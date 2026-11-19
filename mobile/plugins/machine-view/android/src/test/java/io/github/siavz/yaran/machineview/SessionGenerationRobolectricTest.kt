/**
 * SessionGenerationRobolectricTest: which sign-in a cleanup may end, which open a late
 * continuation may act on, and when a stored credential may be sent at all (Sol native review
 * round 3), over real HTTPS to a MockWebServer that answers for every host.
 *
 * A cleanup names its sign-in and never ends a later one; a replaced sign-in is revoked; a read,
 * an injection, a password sheet or a share confirm of an older open does nothing once the
 * window moved on or closed; a stored session reaches a machine only bound to the instance it
 * was issued by and the one expected; and the page's own Sign in asks the native sheet while a
 * real Access redirect does not.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, android.content, android.net, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.AlertDialog
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.TextView
import androidx.test.core.app.ApplicationProvider
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlertDialog
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class SessionGenerationRobolectricTest {
    private val lock = TestBindings.lock
    private val vault = TestBindings.vault
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)

    @Before
    fun bindings() {
        lock.apply {
            enabled = false
            locked = false
            promptUnlocks = true
        }
        vault.apply {
            data.clear()
            classes.clear()
            reads.clear()
            locked = false
        }
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { ORG }, lock, { false }))
        rt.directAuth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
            (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply { sslSocketFactory = trust.sslSocketFactory() }
        }
        CookieManager.getInstance().removeAllCookies(null)
        ShadowAlertDialog.reset()
    }

    @After
    fun stop() = server.shutdown()

    private companion object {
        const val ORG = "https://cp.example.com"
        const val A = "a.example.com"
        const val B = "b.example.com"
    }

    private fun status(instance: String?, required: Boolean = true, signedIn: Boolean = false) = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("password_set", true).put("required_here", required).put("signed_in", signedIn).put("client_class", "network")
            .put("transport_encrypted", true).put("native_auth_ui", true).put("instance", instance ?: JSONObject.NULL).toString())

    private fun directWindow(host: String, instance: String?) = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
        .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", host)).toString()).apply { instance?.let { putExtra("instance", it) } }

    private fun orgWindow(host: String) = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", host)

    private fun storeOrgSession(host: String, exp: Long) {
        vault.data["${SessionStore.PREFIX}$host"] = JSONObject().put("org_id", ORG).put("jwt", TestSealer.jwt(exp))
            .put("exp", exp).put("iat", exp - 86_400).put("email", "ada@example.org").toString().toByteArray()
    }

    private fun drainIo() {
        repeat(6) {
            rt.io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun views(g: ViewGroup): List<android.view.View> =
        (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + views(it) else listOf(it) }

    private fun web(a: MachineViewActivity) = views(a.window.decorView as ViewGroup).filterIsInstance<WebView>().first()

    private fun loads(a: MachineViewActivity) = Shadow.extract<PauseShadowWebView>(web(a)).loads

    private fun cookie(host: String) = CookieManager.getInstance().getCookie("https://$host/").orEmpty()

    // F1: shell A returned signed_in, a later sign-in B replaced it, then A's cleanup ran.
    @Test
    fun aCleanupEndsOnlyItsOwnSignInAndAReplacedOneIsRevoked() {
        val a = DirectFlow.keep(rt, DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        assertEquals(DirectSignInOutcome.SignedIn(A, "i1", "idA_aaaaaaaaaaaaaaaaaa"), a)
        assertEquals(0, server.requestCount)

        server.enqueue(MockResponse().setResponseCode(204))
        DirectFlow.keep(rt, DirectSession(A, "tokB", "yaran_session_443", "i1", 2, "idB_bbbbbbbbbbbbbbbbbb"))
        assertEquals("the superseded sign-in is revoked on the machine", "Bearer tokA", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))

        CookieManager.getInstance().setCookie("https://$A/", "yaran_session_443=tokB; Path=/; Secure; HttpOnly")
        assertEquals(DirectSignOutOutcome.NotCurrent, DirectFlow.signOut(rt, A, "idA_aaaaaaaaaaaaaaaaaa"))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("B survives A's cleanup", "tokB", rt.directSessions.get(A)!!.token)
        assertTrue("and so do its cookies", cookie(A).contains("tokB"))
        assertEquals("A's cleanup sent nothing", 1, server.requestCount)

        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(DirectSignOutOutcome.SignedOut(true), DirectFlow.signOut(rt, A, "idB_bbbbbbbbbbbbbbbbbb"))
        assertEquals("Bearer tokB", server.takeRequest(5, TimeUnit.SECONDS)?.getHeader("Authorization"))
        assertNull(rt.directSessions.get(A))

        // An older build's record has no id: a conditional cleanup cannot claim it; removing the machine still can.
        rt.directSessions.put(DirectSession(A, "tokOld", "yaran_session_443", "i1", 1, null))
        assertEquals(DirectSignOutOutcome.NotCurrent, DirectFlow.signOut(rt, A, "idA_aaaaaaaaaaaaaaaaaa"))
        server.enqueue(MockResponse().setResponseCode(204))
        assertEquals(DirectSignOutOutcome.SignedOut(true), DirectFlow.signOut(rt, A, null))
        assertEquals(mapOf("kind" to "not_current"), DirectSignOutOutcome.NotCurrent.toJs())
    }

    // F2: A's session read lands after the window was replaced by B.
    @Test
    fun aLateReadOfTheReplacedOpenInjectsNothing() {
        val now = System.currentTimeMillis() / 1000
        storeOrgSession(A, now + 86_400)
        storeOrgSession(B, now + 90_000)
        server.enqueue(status(null, required = false)) // B's admission probe; A's open never gets that far
        val gate = CountDownLatch(1)
        rt.io.execute { gate.await(5, TimeUnit.SECONDS) } // A's read waits behind this
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, orgWindow(A)).setup()
        ctl.newIntent(orgWindow(B))
        gate.countDown()
        drainIo()
        val w = ctl.get()
        assertEquals(listOf("https://$B/"), loads(w))
        assertTrue(cookie(B).contains(TestSealer.jwt(now + 90_000)))
        assertFalse("A's token never reaches B", cookie(B).contains(TestSealer.jwt(now + 86_400)))
        assertFalse(cookie(A).contains("CF_Authorization"))
    }

    // F2: a share confirm of A answered after B replaced it.
    @Test
    fun aShareConfirmOfTheReplacedOpenNeverHandsOverTheNewFiles() {
        val now = System.currentTimeMillis() / 1000
        storeOrgSession(A, now + 86_400)
        storeOrgSession(B, now + 86_400)
        val a1 = Uri.parse("content://media/a1")
        val b1 = Uri.parse("content://media/b1")
        fun shared(i: Intent, u: Uri) = i.putExtra(MachineViewActivity.K_SHARE, true).apply { clipData = ClipData.newRawUri(null, u) }
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, shared(orgWindow(A), a1)).setup()
        drainIo()
        val oldWeb = web(ctl.get())
        var oldGot: Array<Uri>? = arrayOf()
        shadowOf(oldWeb).webChromeClient!!.onShowFileChooser(oldWeb, { oldGot = it }, Params(WebChromeClient.FileChooserParams.MODE_OPEN))
        val oldConfirm = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        ctl.newIntent(shared(orgWindow(B), b1))
        drainIo()
        assertFalse("the old confirm is gone", oldConfirm.isShowing)
        assertNull("and its page chooser was answered with nothing", oldGot)
        var got: Array<Uri>? = null
        val now2 = web(ctl.get())
        shadowOf(now2).webChromeClient!!.onShowFileChooser(now2, { got = it }, Params(WebChromeClient.FileChooserParams.MODE_OPEN))
        (ShadowAlertDialog.getLatestAlertDialog() as AlertDialog).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(arrayOf(b1).contentEquals(got))
    }

    // F2: the password sheet of a window that closed.
    @Test
    fun aClosedWindowsPasswordSheetIsDismissedAndPostsNothing() {
        server.enqueue(status("i1"))
        server.enqueue(status("i1"))
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "i1")).setup().get()
        drainIo()
        val sheet = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        assertTrue(sheet.isShowing)
        w.close("user", null)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(sheet.isShowing)
        drainIo()
        assertEquals("no password was posted", 2, server.requestCount)
    }

    // F3: an open that expects B never sends A's token, even when the public answer is A's.
    @Test
    fun aStoredTokenIsNeverSentBeforeTheExpectedInstanceIsSeen() {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "inst-A", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        server.enqueue(status("inst-A"))
        server.enqueue(status("inst-A", signedIn = true)) // what a second, credentialed probe would get
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "inst-B")).setup().get()
        drainIo()
        assertNull(server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie"))
        assertNull("no second, credentialed request", server.takeRequest(200, TimeUnit.MILLISECONDS))
        assertTrue(w.isFinishing)
        assertEquals("instance_changed", w.closedWith!!["code"])
    }

    // F3: an older build's record carries no instance: it never authorizes a reuse.
    @Test
    fun anUnboundLegacyTokenIsNeverSentAndIsDropped() {
        rt.directSessions.put(DirectSession(A, "tokLegacy", "yaran_session_443", null, 1, null))
        CookieManager.getInstance().setCookie("https://$A/", "yaran_session_443=tokLegacy; Path=/; Secure; HttpOnly")
        server.enqueue(status("i1"))
        server.enqueue(status("i1")) // the native sheet's own probe
        Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "i1")).setup()
        drainIo()
        repeat(2) { assertNull(server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie")) }
        assertNull(rt.directSessions.get(A))
        assertFalse(cookie(A).contains("tokLegacy"))
        assertEquals("a fresh sign-in is asked for", "Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
    }

    // F3: on a machine that reports no instance, an unbound token is no wildcard either.
    @Test
    fun anUnboundTokenIsNotReusedOnAMachineWithoutAnInstance() {
        rt.directSessions.put(DirectSession(A, "tokLegacy", "yaran_session_443", null, 1, null))
        server.enqueue(status(null))
        server.enqueue(status(null)) // the native sheet's own probe
        Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, null)).setup()
        drainIo()
        repeat(2) { assertNull(server.takeRequest(1, TimeUnit.SECONDS)!!.getHeader("Cookie")) }
        assertNull("dropped, not kept for later", rt.directSessions.get(A))
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
    }

    // F6: the page's own Sign in asks the native sheet; a real Access redirect does not.
    @Test
    fun thePagesSignInAsksTheNativeSheetAndAccessDoesNot() {
        server.enqueue(status("i1", required = false))
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "i1")).setup().get()
        drainIo()
        w.onNavigation(NavDecision(NavAction.REAUTH, false), "https://team.cloudflareaccess.com/cdn-cgi/access/login/x")
        assertTrue(views(w.window.decorView as ViewGroup).filterIsInstance<TextView>().any { it.text.contains("behind Cloudflare Access") && it.isShown })
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        server.enqueue(status("i1")) // the sheet's own probe: a password is needed now
        w.onNavigation(NavDecision(NavAction.REAUTH, false), "yaranapp://reauth?host=$A")
        drainIo()
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
    }

    private class Params(private val m: Int) : WebChromeClient.FileChooserParams() {
        override fun getMode() = m
        override fun getAcceptTypes() = arrayOf("*/*")
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT)
    }
}
