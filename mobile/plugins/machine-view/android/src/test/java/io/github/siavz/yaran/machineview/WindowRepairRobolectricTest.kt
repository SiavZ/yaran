/**
 * WindowRepairRobolectricTest: the machine window's credential and lifecycle edges, over real
 * HTTPS to a MockWebServer that answers for every host (Sol native review round 2).
 *
 * A kept replacement instance never sees the old machine's cookie; another org's session for
 * the same host is never sent and a sign-in is re-probed against the instance; a second open
 * replaces the window's target and shared files; a wrong then right password clears the
 * overlay; a long resume re-checks a direct session and asks for the password when it ended;
 * and a renderer lost under the lock reloads exactly once, on whichever route answers.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.WindowRepairRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, android.content, android.net, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, java.net, java.time, java.util.concurrent, javax.net.ssl, okhttp3.mockwebserver, okhttp3.tls, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
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
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
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
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowSystemClock
import java.net.URL
import java.time.Duration
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], shadows = [PauseShadowWebView::class])
class WindowRepairRobolectricTest {
    private val lock = TestBindings.lock
    private val vault = TestBindings.vault
    private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        start()
    }
    private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Before
    fun bindings() {
        lock.apply {
            enabled = false
            locked = false
            promptUnlocks = true
            prompts = 0
        }
        vault.apply {
            data.clear()
            classes.clear()
            reads.clear()
            locked = false
        }
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { ORG }, lock, { false }))
        PluginRuntime.get(app).directAuth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
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

    private fun direct(vararg hosts: String) = JSONArray(hosts.map { JSONObject().put("kind", "direct").put("host", it) })

    private fun window(kind: String, routes: JSONArray, instance: String?) = Intent(app, MachineViewActivity::class.java)
        .putExtra("kind", kind).putExtra("routes", routes.toString()).apply { instance?.let { putExtra("instance", it) } }

    private fun orgWindow(host: String) = Intent(app, MachineViewActivity::class.java).putExtra("orgId", ORG).putExtra("machineId", "m1").putExtra("host", host)

    private fun storeOrgSession(host: String, org: String) {
        val now = System.currentTimeMillis() / 1000
        vault.data["${SessionStore.PREFIX}$host"] = JSONObject().put("org_id", org).put("jwt", TestSealer.jwt(now + 86_400))
            .put("exp", now + 86_400).put("iat", now).put("email", "ada@example.org").toString().toByteArray()
    }

    private fun drainIo() {
        repeat(6) {
            PluginRuntime.get(app).io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    private fun web(a: MachineViewActivity) = find<WebView>(a.window.decorView as ViewGroup)!!

    private fun loads(a: MachineViewActivity) = Shadow.extract<PauseShadowWebView>(web(a)).loads

    private fun cookie(host: String) = CookieManager.getInstance().getCookie("https://$host/").orEmpty()

    private fun texts(a: MachineViewActivity) = all<TextView>(a.window.decorView as ViewGroup)
        .filter { it !is Button && generateSequence<android.view.View>(it) { v -> v.parent as? android.view.View }.all { v -> v.visibility == android.view.View.VISIBLE } }
        .map { it.text.toString() }

    /** Types into the native password sheet and presses Sign in. */
    private fun typePassword(text: String) {
        val dialog = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        all<EditText>(shadowOf(dialog).view as ViewGroup).single().setText(text)
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        drainIo()
    }

    private fun views(g: ViewGroup): List<android.view.View> =
        (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + views(it) else listOf(it) }

    private inline fun <reified T> all(g: ViewGroup): List<T> = views(g).filterIsInstance<T>()

    private inline fun <reified T> find(g: ViewGroup): T? = all<T>(g).firstOrNull()

    @Test
    fun aKeptReplacementInstanceGetsNoCookieOfTheOldOne() {
        // The phone signed in to the old machine at A, and its cookie is still in the process store.
        DirectSessionStore(vault).put(DirectSession(A, "tokOld", "yaran_session_443", "i-old", 1))
        CookieManager.getInstance().setCookie("https://$A/", "yaran_session_443=tokOld; Path=/; Secure; HttpOnly")
        // The user kept the machine that answers now (instance i-new), which wants no password.
        server.enqueue(status("i-new", required = false))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", direct(A), "i-new")).setup().get()
        drainIo()
        assertEquals(listOf("https://$A/"), loads(a))
        assertFalse("the old token is gone from the cookie store: ${cookie(A)} record=${vault.data.keys}", cookie(A).contains("tokOld"))
        assertNull("and from the vault", DirectSessionStore(vault).get(A))
        assertNull("no request carried it", server.takeRequest().getHeader("Cookie"))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun aKeptReplacementThatWantsAPasswordAsksInsteadOfReusingTheOldToken() {
        DirectSessionStore(vault).put(DirectSession(A, "tokOld", "yaran_session_443", "i-old", 1))
        server.enqueue(status("i-new"))
        server.enqueue(status("i-new")) // the sheet's own unauthenticated probe
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", direct(A), "i-new")).setup().get()
        drainIo()
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
        assertTrue(loads(a).isEmpty())
        assertFalse(cookie(A).contains("tokOld"))
        repeat(2) { assertNull(server.takeRequest().getHeader("Cookie")) }
    }

    @Test
    fun anotherOrgsSessionIsNeverSentAndASignInIsCheckedAgainstTheInstance() {
        storeOrgSession(A, "https://other.example.com")
        val routes = JSONArray().put(JSONObject().put("kind", "org").put("orgId", ORG).put("machineId", "m1").put("host", A))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("routes", routes, "i1")).setup().get()
        drainIo()
        assertEquals("nothing reached the machine", 0, server.requestCount)
        assertTrue(loads(a).isEmpty())
        assertFalse(cookie(A).contains("CF_Authorization"))

        // The right org's sign-in lands; the renewal path then probes before anything loads.
        storeOrgSession(A, ORG)
        server.enqueue(status("someone-else", required = false))
        a.reloadSameUrl()
        drainIo()
        assertTrue("another instance behind the route loads nothing", loads(a).isEmpty())
        assertTrue(texts(a).any { it.contains("isn't answering on this route") })
        assertTrue(server.takeRequest().getHeader("Cookie")!!.startsWith("CF_Authorization="))

        server.enqueue(status("i1", required = false))
        a.reloadSameUrl()
        drainIo()
        assertEquals(listOf("https://$A/"), loads(a))
        assertTrue(cookie(A).contains("CF_Authorization="))
    }

    @Test
    fun aSecondOpenReplacesTheTargetAndItsSharedFiles() {
        storeOrgSession(A, ORG)
        storeOrgSession(B, ORG)
        repeat(2) { server.enqueue(status(null, required = false)) } // each org page's admission probe
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, orgWindow(A)).setup()
        val a = ctl.get()
        drainIo()
        val first = web(a)
        assertEquals(listOf("https://$A/"), loads(a))
        val c1 = Uri.parse("content://media/1")
        val c2 = Uri.parse("content://media/2")
        val next = orgWindow(B).putExtra(MachineViewActivity.K_SHARE, true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .apply { clipData = ClipData.newRawUri(null, c1).apply { addItem(ClipData.Item(c2)) } }
        ctl.newIntent(next)
        drainIo()
        assertEquals("the old target is reported closed, with its own host",
            mapOf("reason" to "user", "host" to A, "requestedHost" to A), a.closedWith)
        assertFalse("the window itself stays", a.isFinishing)
        assertNotSame(first, web(a))
        assertEquals(listOf("https://$B/"), loads(a))
        assertTrue(texts(a).contains("2 shared files are ready. Open an agent and choose Attach a file."))
        var got: Array<Uri>? = null
        shadowOf(web(a)).webChromeClient!!.onShowFileChooser(web(a), { got = it }, Params(android.webkit.WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE))
        (ShadowAlertDialog.getLatestAlertDialog() as AlertDialog).getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(arrayOf(c1, c2).contentEquals(got))
        a.close("user", null)
        assertEquals(mapOf("reason" to "user", "host" to B, "requestedHost" to B), a.closedWith)
    }

    @Test
    fun aWrongThenRightPasswordClearsTheOverlay() {
        server.enqueue(status("i1"))
        server.enqueue(status("i1"))
        server.enqueue(MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json")
            .setBody("""{"error":"wrong_password","message":"That password is not right."}"""))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", direct(A), "i1")).setup().get()
        drainIo()
        typePassword("nope")
        assertTrue("${texts(a)} ${server.requestCount}", texts(a).any { it.contains("didn't accept that password") && it.contains("That password is not right.") })

        server.enqueue(status("i1"))
        server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("""{"token":"tok1","expires_at":null,"cookie_name":"yaran_session_443"}"""))
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        all<Button>(a.window.decorView as ViewGroup).first { it.text == "Sign in" }.performClick()
        drainIo()
        typePassword("right")
        assertFalse("the overlay is gone once the page loads", texts(a).any { it.contains("Sign-in needed") })
        assertEquals(listOf("https://$A/"), loads(a))
        assertTrue(cookie(A).contains("yaran_session_443=tok1"))
    }

    @Test
    fun aWrongPasswordThenNoPasswordNeededClearsTheOverlay() {
        server.enqueue(status("i1"))
        server.enqueue(status("i1"))
        server.enqueue(MockResponse().setResponseCode(401).setHeader("Content-Type", "application/json").setBody("""{"error":"wrong_password","message":"No."}"""))
        val a = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", direct(A), "i1")).setup().get()
        drainIo()
        typePassword("nope")
        server.enqueue(status("i1", required = false)) // the sheet's probe: the machine now lets this route in
        server.enqueue(status("i1", required = false)) // the re-probe before loading
        all<Button>(a.window.decorView as ViewGroup).first { it.text == "Sign in" }.performClick()
        drainIo()
        assertFalse(texts(a).any { it.contains("Sign-in needed") })
        assertEquals(listOf("https://$A/"), loads(a))
    }

    @Test
    fun aLongResumeChecksTheDirectSessionAndAsksWhenItEnded() {
        DirectSessionStore(vault).put(DirectSession(A, "tok1", "yaran_session_443", "i1", 1))
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window("direct", direct(A), "i1")).setup()
        val a = ctl.get()
        drainIo()
        assertEquals(1, loads(a).size)

        ctl.pause()
        ctl.resume() // a short trip away: nothing is probed
        drainIo()
        assertEquals(2, server.requestCount)

        ctl.pause()
        ShadowSystemClock.advanceBy(Duration.ofSeconds(31))
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = true))
        ctl.resume()
        drainIo()
        assertEquals("a healthy page is kept, not reloaded", 1, loads(a).size)
        assertNull(ShadowAlertDialog.getLatestAlertDialog())

        ctl.pause()
        ShadowSystemClock.advanceBy(Duration.ofSeconds(31))
        server.enqueue(status("i1"))
        server.enqueue(status("i1", signedIn = false)) // the token idled out while the phone was away
        server.enqueue(status("i1")) // the sheet's own probe
        ctl.resume()
        drainIo()
        assertEquals("Sign in to $A", shadowOf(ShadowAlertDialog.getLatestAlertDialog()).title)
        assertEquals(1, loads(a).size)
    }

    @Test
    fun aRendererLostUnderTheLockReloadsOnceOnTheRouteThatAnswers() {
        for (aDown in listOf(false, true)) {
            server.enqueue(status("i1", required = false))
            val ctl = Robolectric.buildActivity(MachineViewActivity::class.java, window("routes", direct(A, B), "i1")).setup()
            val a = ctl.get()
            drainIo()
            lock.enabled = true
            lock.locked = true
            lock.promptUnlocks = false
            ctl.pause()
            ctl.resume()
            a.onRendererGone(web(a))
            assertTrue("nothing loads behind the lock", loads(a).isEmpty())
            ShadowSystemClock.advanceBy(Duration.ofSeconds(31))
            if (aDown) server.enqueue(MockResponse().setResponseCode(502))
            server.enqueue(status("i1", required = false))
            lock.promptUnlocks = true
            all<Button>(a.window.decorView as ViewGroup).first { it.text == "Unlock" }.performClick()
            drainIo()
            assertEquals("route A down=$aDown", listOf("https://${if (aDown) B else A}/"), loads(a))
            server.takeRequest(1, TimeUnit.SECONDS)
            lock.enabled = false
            a.close("user", null)
        }
    }

    private class Params(private val m: Int) : android.webkit.WebChromeClient.FileChooserParams() {
        override fun getMode() = m
        override fun getAcceptTypes() = arrayOf("*/*")
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT)
    }
}
