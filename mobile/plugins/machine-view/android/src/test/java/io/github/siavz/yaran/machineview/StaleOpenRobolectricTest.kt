/**
 * StaleOpenRobolectricTest: io work of an open that a newer open replaced acts on nothing
 * (Sol native review round 4), over real HTTPS to a MockWebServer that answers for every host.
 *
 * The check runs on the io thread before the work acts, against what the asking open saw when it
 * asked: a session read queued by open A and run after B replaced it neither reads B's context nor
 * deletes A's kept session, and a password preflight A started shows no sheet once B is up.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.StaleOpenRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, android.content, android.net, android.os, android.view, android.webkit, androidx.test.core.app, java.net, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
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
class StaleOpenRobolectricTest {
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
        }
        vault.apply {
            data.clear()
            classes.clear()
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

    private fun status(instance: String, required: Boolean = true, signedIn: Boolean = false) = MockResponse().setHeader("Content-Type", "application/json")
        .setBody(JSONObject().put("password_set", true).put("required_here", required).put("signed_in", signedIn).put("client_class", "network")
            .put("transport_encrypted", true).put("native_auth_ui", true).put("instance", instance).toString())

    private fun directWindow(host: String, instance: String) = Intent(app, MachineViewActivity::class.java).putExtra("kind", "direct")
        .putExtra("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", host)).toString()).putExtra("instance", instance)

    private fun orgWindow(host: String): Intent {
        val exp = System.currentTimeMillis() / 1000 + 86_400
        vault.data["${SessionStore.PREFIX}$host"] = JSONObject().put("org_id", ORG).put("jwt", TestSealer.jwt(exp))
            .put("exp", exp).put("iat", exp - 86_400).put("email", "ada@example.org").toString().toByteArray()
        return Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", host)
    }

    private fun drainIo() {
        repeat(6) {
            rt.io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    // A's refresh read was queued before B replaced it, and ran after: it must not judge A's kept
    // session by B's (empty) context and delete it.
    @Test
    fun aQueuedReadOfTheReplacedOpenDeletesNothing() {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "i1")).setup()
        drainIo()
        val gate = CountDownLatch(1)
        rt.io.execute { gate.await(5, TimeUnit.SECONDS) }
        ctl.get().refreshDirect { }
        ctl.newIntent(orgWindow(B))
        gate.countDown()
        drainIo()
        assertEquals("A's kept session survives", "tokA", rt.directSessions.get(A)?.token)
    }

    private fun routedWindow(vararg hosts: String) = Intent(app, MachineViewActivity::class.java).putExtra("kind", "routes")
        .putExtra("routes", JSONArray(hosts.map { JSONObject().put("kind", "direct").put("host", it) }).toString()).putExtra("instance", "i1")

    private fun cookie(host: String) = CookieManager.getInstance().getCookie("https://$host/").orEmpty()

    private val open = DirectStatus.Yaran("i1", true, false, false, true)

    /** A routed window on A with A's session, its io thread held so the next read waits. */
    private fun onAWithAHeldRead(): Pair<MachineViewActivity, CountDownLatch> {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        repeat(4) { server.enqueue(status("i1", signedIn = true)) }
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, routedWindow(A, B)).setup().get()
        drainIo()
        assertEquals(A, w.state.host)
        val gate = CountDownLatch(1)
        rt.io.execute { gate.await(5, TimeUnit.SECONDS) }
        return w to gate
    }

    // Round 5: route A's reinject read lands after the window switched to B.
    @Test
    fun aReadOfTheOldRouteNeverReachesTheNewOne() {
        val (w, gate) = onAWithAHeldRead()
        w.routes.reinject()
        w.routes.onSelected(Selection.Chosen(1), arrayOf(null, open), current = 0, retry = false)
        gate.countDown()
        drainIo()
        assertEquals(B, w.state.host)
        assertFalse("A's token never lands in B's jar", cookie(B).contains("tokA"))
        assertEquals("nor is A's record dropped", "tokA", rt.directSessions.get(A)?.token)
    }

    // Round 5: A to B and back to A; the read A started first is still stale.
    @Test
    fun aReadFromBeforeASwitchBackIsStillStale() {
        val (w, gate) = onAWithAHeldRead()
        var ran = false
        w.refreshDirect { ran = true }
        w.routes.onSelected(Selection.Chosen(1), arrayOf(null, open), current = 0, retry = false)
        w.routes.onSelected(Selection.Chosen(0), arrayOf(open, null), current = 1, retry = false)
        gate.countDown()
        drainIo()
        assertEquals(A, w.state.host)
        assertFalse(ran)
    }

    // A route kept at resume is no switch: nothing is invalidated and the page is not reloaded.
    @Test
    fun aKeptRouteKeepsItsWorkAndItsPage() {
        val (w, gate) = onAWithAHeldRead()
        var ran = false
        w.refreshDirect { ran = true }
        val page = Shadow.extract<PauseShadowWebView>(views(w).filterIsInstance<WebView>().first())
        val loads = page.loads.size
        w.routes.onSelected(Selection.Kept(0), arrayOf(DirectStatus.Yaran("i1", true, true, true, true), null), current = 0, retry = false)
        gate.countDown()
        drainIo()
        assertTrue(ran)
        assertEquals("no reload", loads, page.loads.size)
    }

    // Round 6: the page on A asked for a file and the shared-files confirm is up when a resume
    // probe moves the window to B. A's chooser is answered with nothing, once; B gets the files.
    @Test
    fun aRouteSwitchCancelsTheOldPagesShareConfirmAndKeepsTheFiles() {
        rt.directSessions.put(DirectSession(A, "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        repeat(4) { server.enqueue(status("i1", signedIn = true)) }
        val shared = Uri.parse("content://media/s1")
        val intent = routedWindow(A, B).putExtra(MachineViewActivity.K_SHARE, true).apply { clipData = ClipData.newRawUri(null, shared) }
        val w = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        drainIo()
        val oldPage = views(w).filterIsInstance<WebView>().first()
        val answers = mutableListOf<Array<Uri>?>()
        shadowOf(oldPage).webChromeClient!!.onShowFileChooser(oldPage, { answers += it }, Chooser())
        val confirm = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        w.routes.onSelected(Selection.Chosen(1), arrayOf(null, open), current = 0, retry = false)
        shadowOf(Looper.getMainLooper()).idle()
        assertFalse(confirm.isShowing)
        assertEquals("answered once, with nothing", listOf<Array<Uri>?>(null), answers)
        assertEquals(listOf(shared), w.share.uris)
        val newPage = views(w).filterIsInstance<WebView>().first()
        var got: Array<Uri>? = null
        shadowOf(newPage).webChromeClient!!.onShowFileChooser(newPage, { got = it }, Chooser())
        (ShadowAlertDialog.getLatestAlertDialog() as AlertDialog).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(arrayOf(shared).contentEquals(got))
        assertEquals("the old page heard nothing more", 1, answers.size)
    }

    private class Chooser : WebChromeClient.FileChooserParams() {
        override fun getMode() = MODE_OPEN
        override fun getAcceptTypes() = arrayOf("*/*")
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT)
    }

    private fun views(a: MachineViewActivity): List<android.view.View> {
        fun all(g: ViewGroup): List<android.view.View> =
            (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + all(it) else listOf(it) }
        return all(a.window.decorView as ViewGroup)
    }

    // A's password preflight answered after B replaced it: no sheet for a window that moved on.
    @Test
    fun aPreflightOfTheReplacedOpenShowsNoSheet() {
        server.enqueue(status("i1", required = false))
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, directWindow(A, "i1")).setup()
        drainIo()
        val gate = CountDownLatch(1)
        rt.io.execute { gate.await(5, TimeUnit.SECONDS) }
        server.enqueue(status("i1")) // the preflight: a password is needed now
        server.enqueue(status("i1", required = false)) // B's admission probe
        ctl.get().onNavigation(NavDecision(NavAction.REAUTH, false), "yaranapp://reauth?host=$A")
        ctl.newIntent(orgWindow(B))
        gate.countDown()
        drainIo()
        assertEquals("the preflight and B's admission probe ran", 3, server.requestCount)
        assertNull("no sheet over B", ShadowAlertDialog.getLatestAlertDialog())
    }
}
