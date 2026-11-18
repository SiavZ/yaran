/**
 * AdmissionRobolectricTest: a document of the machine's page loads only with an admission for
 * that one load, for the machine the window's context belongs to (Sol native review round 7).
 *
 * Document requests the page starts itself (a reload, a link, a form, a served reload after a
 * build change) are admitted in `shouldInterceptRequest`, like the native load; a resume that
 * keeps the page grants nothing a later reload could spend; and a reload that finds another
 * instance at the route chooses again instead of carrying the old instance's session along.
 * Every request goes to a loopback stand-in.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.AdmissionRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.WindowEvents (inferred)
 * External: android.content, android.net, android.os, android.view, android.webkit, androidx.test.core.app, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class AdmissionRobolectricTest {
    private val vault = TestBindings.vault
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val yaran = FakeYaran(compatible("i1"))

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
        rt.directAuth = yaran.auth
        CookieManager.getInstance().removeAllCookies(null)
        ShadowAlertDialog.reset()
    }

    @After
    fun stop() = yaran.close()

    private companion object {
        const val A = "a.example.com"
        const val PAGE = "https://$A/"

        /** A compatible yaran at [instance] that wants a password and sees the phone signed in. */
        fun compatible(instance: String, capable: Boolean = true) = FakeYaran.capableStatus(capable).put("instance", instance)
            .put("password_set", true).put("required_here", true).put("signed_in", true)
    }

    private fun drainIo() {
        repeat(6) {
            rt.io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun web(a: MachineViewActivity): WebView {
        fun all(g: ViewGroup): List<android.view.View> =
            (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + all(it) else listOf(it) }
        return all(a.window.decorView as ViewGroup).filterIsInstance<WebView>().first()
    }

    private fun loads(a: MachineViewActivity) = Shadow.extract<PauseShadowWebView>(web(a)).loads

    /** A direct window on A, signed in with a session A's instance i1 issued. */
    private fun openSignedIn(): MachineViewActivity {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
            .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).toString())
        return Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get().also {
            drainIo()
            assertEquals(listOf(PAGE), loads(it))
            assertTrue(CookieManager.getInstance().getCookie(PAGE).orEmpty().contains("tokA"))
            // What a real WebView does next (the shadow loads nothing): the load's document request,
            // admitted by the pass the native load left, with no second probe.
            val probes = yaran.requests
            assertTrue(it.admitDocument(PAGE))
            assertEquals(probes, yaran.requests)
        }
    }

    private fun mainFrame(url: String, mainFrame: Boolean = true, method: String = "GET") = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame() = mainFrame
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = method
        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    // Finding 3: the page reloads itself (a served reload after a build change) after the machine
    // was replaced by an older build: the document request is refused before it loads.
    @Test
    fun aDocumentThePageStartsIsAdmittedLikeANativeLoad() {
        val w = openSignedIn()
        val client = MachineWebViewClient(w)
        val before = yaran.requests
        assertNull("a subresource is not a document", client.shouldInterceptRequest(web(w), mainFrame("${PAGE}assets/app.js", mainFrame = false)))
        assertEquals("and costs no probe", before, yaran.requests)
        assertNull("the compatible machine's reload loads", client.shouldInterceptRequest(web(w), mainFrame(PAGE)))
        assertTrue("after its own probe", yaran.requests > before)
        yaran.body = compatible("i1", capable = false)
        val refused = client.shouldInterceptRequest(web(w), mainFrame("$PAGE#/agent/s1"))
        assertEquals(204, refused!!.statusCode)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("upgrade_required", w.closedWith!!["code"])
    }

    // The native load's own document request is the load it admitted: no second probe.
    @Test
    fun theNativeLoadsDocumentNeedsNoSecondProbe() {
        val w = openSignedIn()
        val before = yaran.requests
        assertTrue("nothing passed now: probed, and admitted", w.admitDocument("$PAGE#/agent/s1"))
        assertTrue(yaran.requests > before)
        w.load(PAGE) // probes (no admission), then passes its document
        drainIo()
        val probed = yaran.requests
        assertTrue(w.admitDocument(PAGE))
        assertEquals("the pass, not a probe", probed, yaran.requests)
        assertTrue(w.admitDocument(PAGE))
        assertTrue("spent once: the next document probes", yaran.requests > probed)
    }

    // Finding 4: a resume that keeps the page grants nothing; a later reload after the machine
    // lost the capability is probed and refused.
    @Test
    fun aKeptPageHoldsNoAdmissionForALaterReload() {
        val w = openSignedIn()
        w.routes.onSelected(Selection.Kept(0), arrayOf(DirectStatus.Yaran("i1", true, true, true, true)), current = 0, retry = false)
        drainIo()
        assertNull(w.admitted)
        yaran.body = compatible("i1", capable = false)
        w.load(w.state.url)
        drainIo()
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertEquals("no second load", listOf(PAGE), loads(w))
    }

    // Round 9: a form posts the main frame to another origin (form posts skip
    // shouldOverrideUrlLoading). Another host, another port and plain http are each blocked with
    // the empty answer, before any pass or probe: nothing reaches them, and the native load's own
    // pass is still there for its own document. The route's origin spelled with :443 is the route's.
    @Test
    fun aDocumentForAnotherOriginIsBlockedBeforeAnyPassOrProbe() {
        val w = openSignedIn()
        val client = MachineWebViewClient(w)
        w.load(PAGE) // probes, then passes its own document
        drainIo()
        val probes = yaran.requests
        for (other in listOf("https://evil.example.com/collect", "https://$A:8443/", "http://$A/")) {
            assertEquals(other, 204, client.shouldInterceptRequest(web(w), mainFrame(other, method = "POST"))!!.statusCode)
        }
        assertEquals("nothing probed or sent", probes, yaran.requests)
        assertNull("nothing acted on", w.closedWith)
        assertNull("the native load's pass was not spent by them", client.shouldInterceptRequest(web(w), mainFrame(PAGE)))
        assertEquals(probes, yaran.requests)
        assertNull("the route's own origin, :443 spelled out", client.shouldInterceptRequest(web(w), mainFrame("https://$A:443/", method = "POST")))
        assertTrue(yaran.requests > probes)
    }

    // Round 9: the public status still looks like the compatible i1, but the authenticated one,
    // the newer answer, is from a build too old for the app. The reload is refused on it.
    @Test
    fun aReloadWhoseAuthenticatedStatusIsTooOldIsRefused() {
        val w = openSignedIn()
        yaran.signedBody = compatible("i1", capable = false)
        assertFalse(MachineWebViewClient(w).shouldInterceptRequest(web(w), mainFrame(PAGE)) == null)
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("upgrade_required", w.closedWith!!["code"])
    }

    // Round 9: the authenticated answer is from instance i2: the reload chooses again instead of
    // loading, and i1's session goes rather than being carried to i2.
    @Test
    fun aReloadWhoseAuthenticatedStatusIsAnotherInstanceChoosesAgain() {
        val w = openSignedIn()
        yaran.signedBody = compatible("i2").put("signed_in", false) // i2 does not know i1's token
        assertFalse(MachineWebViewClient(w).shouldInterceptRequest(web(w), mainFrame(PAGE)) == null)
        drainIo()
        assertNull("i1's session is not carried to i2", rt.directSessions.get(A))
        assertFalse(CookieManager.getInstance().getCookie(PAGE).orEmpty().contains("tokA"))
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
    }

    // Round 10: the renderer dies while unlocked and the reload's admission finds the machine
    // offline, so nothing is submitted. The reload stays owed: a later long-away resume that keeps
    // the healthy route reloads the page exactly once rather than only re-injecting a blank one.
    @Test
    fun anUnlockedCrashWhoseReloadFoundTheMachineOfflineIsStillOwed() {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
            .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).toString())
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup()
        drainIo()
        val w = ctl.get()
        assertTrue(w.admitDocument(PAGE)) // the open's own document, as a WebView would ask
        yaran.offline = true
        w.onRendererGone(web(w))
        drainIo()
        assertEquals("the reload found nobody: nothing loaded", emptyList<String>(), loads(w))
        assertTrue("and it is still owed", w.reloadAtUnlock)
        yaran.offline = false
        ctl.pause()
        w.pausedAt = android.os.SystemClock.elapsedRealtime() - MachineViewActivity.PARKED_MS - 1
        ctl.resume()
        drainIo()
        assertEquals("exactly one reload", listOf(PAGE), loads(w))
        assertFalse(w.reloadAtUnlock)
    }

    // Round 10: admission passes but no navigation is submitted (this org window holds no session
    // of its own yet, so its load asks for sign-in instead). The reload stays owed.
    @Test
    fun anAdmittedReloadThatSubmitsNothingStaysOwed() {
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("orgId", "https://cp.example.com").putExtra("machineId", "m1")
            .putExtra("host", A)
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        drainIo()
        val exp = System.currentTimeMillis() / 1000 + 86_400
        vault.data["${SessionStore.PREFIX}$A"] = JSONObject().put("org_id", "https://cp.example.com").put("jwt", TestSealer.jwt(exp))
            .put("exp", exp).put("iat", exp - 86_400).put("email", "ada@example.org").toString().toByteArray() // the probe finds it
        yaran.body = FakeYaran.capableStatus()
        val probes = yaran.requests
        w.onRendererGone(web(w))
        drainIo()
        assertTrue("admitted by a probe", yaran.requests > probes)
        assertEquals("but nothing submitted", emptyList<String>(), loads(w))
        assertTrue("so still owed", w.reloadAtUnlock)
    }

    // Finding 2: the machine at A is now another instance when the renderer is recovered. The
    // reload chooses again instead of loading B with A's session: A's record and cookie go and
    // the password is asked for, nothing is loaded meanwhile.
    @Test
    fun aRendererRecoveryThatFindsAnotherInstanceNeverCarriesTheOldSession() {
        val w = openSignedIn()
        yaran.body = compatible("i2").put("signed_in", false)
        w.onRendererGone(web(w))
        drainIo()
        assertNull("A's session was dropped, not sent to B", rt.directSessions.get(A))
        assertFalse(CookieManager.getInstance().getCookie(PAGE).orEmpty().contains("tokA"))
        assertEquals("nothing loaded with A's context", emptyList<String>(), loads(w))
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
    }
}
