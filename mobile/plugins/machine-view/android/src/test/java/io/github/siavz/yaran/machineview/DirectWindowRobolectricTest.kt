/**
 * DirectWindowRobolectricTest: the machine window's direct, routed and share paths, and a
 * stored session that is there but unreadable.
 *
 * The window probes over real HTTPS against a MockWebServer (every host maps to it), so a
 * route is chosen, switched and loaded exactly as on a device, with only its own cookie in the
 * process cookie store. The share half drives the page's file chooser through the WebView's
 * own chrome client.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DirectWindowRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.ShareHolder (inferred)
 * External: android.app, android.content, android.net, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadows
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
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.Button
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
import org.robolectric.shadows.ShadowAlertDialog
import java.net.URL
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class DirectWindowRobolectricTest {
    private val lock = TestBindings.lock
    private val vault = TestBindings.vault
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val asked = mutableListOf<String>()
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Before
    fun bindings() {
        lock.apply {
            enabled = false
            locked = false
        }
        vault.apply {
            data.clear()
            classes.clear()
            reads.clear()
            locked = false
        }
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { ORG }, lock, { false }))
        PluginRuntime.get(app).directAuth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
            asked += url.host
            (URL("https", "localhost", server.port, url.file).openConnection() as HttpsURLConnection).apply { sslSocketFactory = trust.sslSocketFactory() }
        }
        CookieManager.getInstance().removeAllCookies(null)
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

    private fun window(kind: String, hosts: List<String>, instance: String?, extra: Intent.() -> Unit = {}): Intent {
        val routes = JSONArray(hosts.map { JSONObject().put("kind", "direct").put("host", it) })
        return Intent(app, MachineViewActivity::class.java).putExtra("kind", kind).putExtra("routes", routes.toString())
            .apply { instance?.let { putExtra("instance", it) } }.apply(extra)
    }

    private fun storeDirect(host: String, token: String, instance: String?) =
        DirectSessionStore(vault).put(DirectSession(host, token, "yaran_session_443", instance, 1))

    private fun drainIo() {
        repeat(4) {
            PluginRuntime.get(app).io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    @Test
    fun anOrgRouteIsProbedOnlyWithItsOwnOrgSession() {
        val rt = PluginRuntime.get(app)
        val route = Route.Org(ORG, "m1", A)
        assertEquals("no session: nothing is sent", mapOf("kind" to "sign_in_required"), DirectFlow.routeStatus(rt, route))
        assertEquals(0, server.requestCount)

        val now = System.currentTimeMillis() / 1000
        val jwt = TestSealer.jwt(now + 3_600)
        vault.data["${SessionStore.PREFIX}$A"] = JSONObject().put("org_id", "https://other.example.com").put("jwt", jwt)
            .put("exp", now + 3_600).put("iat", now).put("email", "ada@example.org").toString().toByteArray()
        assertEquals("another org's session is not this route's", mapOf("kind" to "sign_in_required"), DirectFlow.routeStatus(rt, route))
        assertEquals(0, server.requestCount)

        vault.data["${SessionStore.PREFIX}$A"] = JSONObject().put("org_id", ORG).put("jwt", jwt)
            .put("exp", now + 3_600).put("iat", now).put("email", "ada@example.org").toString().toByteArray()
        storeDirect(B, "tokB", "i1")
        server.enqueue(status("i1", required = false))
        val got = DirectFlow.routeStatus(rt, route)
        assertEquals(listOf("yaran", "i1"), listOf(got["kind"], got["instance"]))
        val r = server.takeRequest()
        assertEquals("/api/v1/auth/status", r.path)
        assertEquals("CF_Authorization=$jwt", r.getHeader("Cookie"))

        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login/x"))
        server.enqueue(status("i1"))
        assertEquals("Access in front means sign in again", mapOf("kind" to "sign_in_required"), DirectFlow.routeStatus(rt, route))
        assertEquals(A, asked.last())
        assertFalse("the redirect is never followed and no other credential is tried", asked.contains(B))
    }

    @Test
    fun anUnreadableOrgSessionSaysSoAndStartsNoSignIn() {
        vault.data["${SessionStore.PREFIX}laptop.example.com"] = "{not json".toByteArray()
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", "laptop.example.com")
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        drainIo()
        val decor = a.window.decorView as ViewGroup
        assertTrue(texts(decor).any { it.contains("can't be read on this phone") })
        assertTrue(findButton(decor, "Sign in") != null)
        // A sign-in starts by reading the install id and writing the handoff marker; reading the
        // marker alone is the launcher looking for an Auth Tab result still owed (round 8).
        assertFalse("no sign-in starts by itself", vault.reads.any { it.startsWith("install/") } || vault.writes.any { it.first == "handoff" })
        assertNull(shadowOf(findWebView(decor)!!).lastLoadedUrl)
    }

    @Test
    fun aDirectWindowLoadsWithOnlyItsOwnCookie() {
        storeDirect(A, "tokA", "i1")
        storeDirect(B, "tokB", "i1")
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", listOf(A), "i1") { putExtra("route", "#/agent/s1") }).setup().get()
        drainIo()
        assertEquals("https://$A/#/agent/s1", shadowOf(findWebView(a.window.decorView as ViewGroup)!!).lastLoadedUrl)
        assertTrue(CookieManager.getInstance().getCookie("https://$A/").orEmpty().contains("yaran_session_443=tokA"))
        assertFalse("another host's session is never injected", CookieManager.getInstance().getCookie("https://$B/").orEmpty().contains("tokB"))
        assertNull(server.takeRequest().getHeader("Cookie"))
        assertEquals("yaran_session_443=tokA", server.takeRequest().getHeader("Cookie"))
        assertFalse(a.isFinishing)
    }

    @Test
    fun aDifferentMachineAtTheHostClosesTheWindowWithoutLoading() {
        storeDirect(A, "tokA", "i1")
        server.enqueue(status("someone-else"))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", listOf(A), "i1")).setup().get()
        drainIo()
        assertTrue(a.isFinishing)
        assertNull(shadowOf(findWebView(a.window.decorView as ViewGroup)!!).lastLoadedUrl)
        assertEquals("the token never went to it", 1, server.requestCount)
        assertEquals("the close names the host that was rejected",
            mapOf("reason" to "error", "code" to "instance_changed", "host" to A, "requestedHost" to A), a.closedWith)
    }

    @Test
    fun anAccessRedirectOnADirectMachineSaysWhereItBelongs() {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://team.cloudflareaccess.com/cdn-cgi/access/login/x"))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", listOf(A), null)).setup().get()
        drainIo()
        assertFalse(a.isFinishing)
        assertTrue(texts(a.window.decorView as ViewGroup).any { it.contains("behind Cloudflare Access") })
    }

    @Test
    fun aRoutedWindowSkipsADeadRouteOntoAFreshWebView() {
        server.enqueue(MockResponse().setResponseCode(502).setBody("bad gateway"))
        server.enqueue(status("i1", required = false))
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window("routes", listOf(A, B), "i1") { putExtra("route", "#/agent/s1") })
        val a = ctl.setup().get()
        val first = findWebView(a.window.decorView as ViewGroup)!!
        drainIo()
        val now = findWebView(a.window.decorView as ViewGroup)!!
        assertNotSame("a route switch never reuses the page", first, now)
        assertEquals(listOf(A, B), asked)
        assertEquals("the agent route rides over to the new origin", "https://$B/#/agent/s1", shadowOf(now).lastLoadedUrl)
        assertEquals(B, a.state.host)
        a.close("user", null)
        assertEquals("a routed close names the route it was on", mapOf("reason" to "user", "host" to B, "requestedHost" to A), a.closedWith)
    }

    @Test
    fun aRoutedWindowNoRouteAnswersClosesAtOpenButNotOnRetry() {
        server.enqueue(status("other"))
        server.enqueue(MockResponse().setResponseCode(404))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("routes", listOf(A, B), "i1")).setup().get()
        drainIo()
        assertTrue(a.isFinishing)
        assertEquals("no route was chosen, so no host is named", mapOf("reason" to "error", "code" to "no_route", "requestedHost" to A), a.closedWith)

        val b = Robolectric.buildActivity(MachineViewActivity::class.java, window("routes", listOf(A, B), "i1")).create().get()
        b.routes.onSelected(Selection.NoRoute, arrayOfNulls(2), 0, retry = true)
        assertFalse(b.isFinishing)
        val decor = b.window.decorView as ViewGroup
        assertTrue(texts(decor).any { it.contains("isn't answering on this route") })
        assertTrue(findButton(decor, "Try another route") != null)
    }

    @Test
    fun sharedFilesAreOfferedToThePageChooserOnce() {
        val c1 = Uri.parse("content://media/1")
        val c2 = Uri.parse("content://media/2")
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", "laptop.example.com")
            .putExtra(MachineViewActivity.K_SHARE, true)
            .apply { clipData = ClipData.newRawUri(null, c1).apply { addItem(ClipData.Item(Uri.parse("file:///etc/passwd"))); addItem(ClipData.Item(c2)) } }
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        val decor = a.window.decorView as ViewGroup
        assertTrue(texts(decor).any { it == "2 shared files are ready. Open an agent and choose Attach a file." })
        val chrome = shadowOf(findWebView(decor)!!).webChromeClient!!
        var got: Array<Uri>? = arrayOf()
        chrome.onShowFileChooser(findWebView(decor)!!, { got = it }, Params(WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE))
        val dialog = ShadowAlertDialog.getLatestAlertDialog()!!
        assertEquals("Attach the 2 shared files here?", shadowOf(dialog).message.toString())
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(arrayOf(c1, c2).contentEquals(got))
        assertFalse("delivered files are forgotten", texts(decor).any { it.contains("shared files are ready") && isShown(decor, it) })

        ShadowAlertDialog.reset()
        chrome.onShowFileChooser(findWebView(decor)!!, { }, Params(WebChromeClient.FileChooserParams.MODE_OPEN))
        assertNull("nothing is offered twice", ShadowAlertDialog.getLatestAlertDialog())
    }

    @Test
    fun aSingleFileInputTakesOnlyTheFirstSharedFile() {
        val c1 = Uri.parse("content://media/1")
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", "laptop.example.com")
            .putExtra(MachineViewActivity.K_SHARE, true)
            .apply { clipData = ClipData.newRawUri(null, c1).apply { addItem(ClipData.Item(Uri.parse("content://media/2"))) } }
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        val web = findWebView(a.window.decorView as ViewGroup)!!
        var got: Array<Uri>? = null
        shadowOf(web).webChromeClient!!.onShowFileChooser(web, { got = it }, Params(WebChromeClient.FileChooserParams.MODE_OPEN))
        val dialog = ShadowAlertDialog.getLatestAlertDialog()!!
        assertTrue(shadowOf(dialog).message.toString().startsWith("This page takes one file."))
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(arrayOf(c1).contentEquals(got))
    }

    @Test
    fun aRestoredWindowHoldsNoSharedFiles() {
        val intent = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", "laptop.example.com")
            .putExtra(MachineViewActivity.K_SHARE, true).apply { clipData = ClipData.newRawUri(null, Uri.parse("content://media/1")) }
        val saved = android.os.Bundle().also { MachineState.of(ORG, "m1", "laptop.example.com", null)!!.toBundle(it) }
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, intent).create(saved).start().resume().get()
        assertFalse(texts(a.window.decorView as ViewGroup).any { it.contains("shared files are ready") })
    }

    @Test
    fun theShareIntakeKeepsContentOnlyAndWaitsForTheUnlock() {
        val many = (1..12).map { Uri.parse("content://media/$it") } + Uri.parse("file:///sdcard/x") + null
        val (kept, dropped) = ShareHolder.select(many)
        assertEquals(10, kept.size)
        assertEquals(3, dropped)
        val text = Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_TEXT, "hello").setType("text/plain")
        assertTrue(ShareHolder.intake(text))
        assertEquals(0, ShareHolder.count())
        assertFalse(ShareHolder.intake(Intent(Intent.ACTION_VIEW)))
        val two = Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, arrayListOf(Uri.parse("content://a/1"), Uri.parse("content://a/2")))
        assertTrue(ShareHolder.intake(two))
        assertEquals(2, ShareHolder.count())
        ShareHolder.discard()
        assertEquals(0, ShareHolder.count())
    }

    @Test
    fun openFormsAreValidatedAndRoundTrip() {
        val routes = JSONArray().put(JSONObject().put("kind", "org").put("orgId", ORG).put("machineId", "m1").put("host", A))
            .put(JSONObject().put("kind", "direct").put("host", B)).toString()
        val s = MachineState.parse("routes", routes, "i1", "#/agent/x")!!
        assertEquals(listOf(A, B), s.routes.map { it.host })
        assertEquals("https://$B/#/agent/x", s.switchTo(1).url)
        val b = android.os.Bundle().also { s.switchTo(1).toBundle(it) }
        assertEquals(1, MachineState.fromBundle(b)!!.chosen)
        assertNull("routes need an instance", MachineState.parse("routes", routes, null, null))
        assertNull("a direct host is public", MachineState.parse("direct", JSONArray().put(JSONObject().put("kind", "direct").put("host", "10.0.0.2")).toString(), null, null))
        assertNull("no duplicate hosts", MachineState.parse("routes", JSONArray().put(JSONObject().put("kind", "direct").put("host", A)).put(JSONObject().put("kind", "direct").put("host", A)).toString(), "i1", null))
        val five = JSONArray((1..5).map { JSONObject().put("kind", "direct").put("host", "h$it.example.com") }).toString()
        assertNull("at most four routes", MachineState.parse("routes", five, "i1", null))
        assertNull("direct takes one direct route", MachineState.parse("direct", routes, null, null))
        assertNull(MachineState.parse("nope", routes, "i1", null))
    }

    private class Params(private val m: Int) : WebChromeClient.FileChooserParams() {
        override fun getMode() = m
        override fun getAcceptTypes() = arrayOf("*/*")
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT)
    }

    private fun texts(g: ViewGroup): List<String> = (0 until g.childCount).flatMap { i ->
        when (val v = g.getChildAt(i)) {
            is Button -> emptyList()
            is TextView -> if (shown(v)) listOf(v.text.toString()) else emptyList()
            is ViewGroup -> texts(v)
            else -> emptyList()
        }
    }

    private fun isShown(decor: ViewGroup, text: String) = texts(decor).contains(text)

    private fun shown(v: View) = generateSequence(v) { it.parent as? View }.all { it.visibility == View.VISIBLE }

    private fun findButton(g: ViewGroup, label: String): Button? {
        for (i in 0 until g.childCount) {
            when (val v = g.getChildAt(i)) {
                is Button -> if (v.text.toString() == label && shown(v)) return v
                is ViewGroup -> findButton(v, label)?.let { return it }
            }
        }
        return null
    }

    private fun findWebView(g: ViewGroup): WebView? {
        for (i in 0 until g.childCount) {
            when (val v = g.getChildAt(i)) {
                is WebView -> return v
                is ViewGroup -> findWebView(v)?.let { return it }
            }
        }
        return null
    }
}
