/**
 * UpgradeRequiredRobolectricTest: a machine's page is admitted only when its yaran says the page
 * signs in natively (`native_auth_ui`, Sol native review round 6), on every kind of window.
 *
 * An older build's page, once loaded, would show its own password form when the machine later
 * asks for one; so no page of it loads at all, whether the route needs no password, is an org
 * route, is one of several routes, or was admitted before and has since been replaced by an
 * older build. Every request goes to a loopback stand-in; nothing leaves the machine.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.UpgradeRequiredRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.content, android.os, android.view, android.webkit, androidx.test.core.app, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation, org.robolectric.shadow.api, org.robolectric.shadows
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.os.Looper
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
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
class UpgradeRequiredRobolectricTest {
    private val vault = TestBindings.vault
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val yaran = FakeYaran(FakeYaran.capableStatus(capable = false))

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
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { ORG }, TestBindings.lock, { false }))
        rt.directAuth = yaran.auth
        CookieManager.getInstance().removeAllCookies(null)
        ShadowAlertDialog.reset()
    }

    @After
    fun stop() = yaran.close()

    private companion object {
        const val ORG = "https://cp.example.com"
        const val A = "a.example.com"
        const val B = "b.example.com"
    }

    private fun window(kind: String, vararg hosts: String) = Intent(app, MachineViewActivity::class.java).putExtra("kind", kind)
        .putExtra("routes", JSONArray(hosts.map { JSONObject().put("kind", "direct").put("host", it) }).toString())

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

    private fun loads(a: MachineViewActivity): List<String> {
        fun all(g: ViewGroup): List<android.view.View> =
            (0 until g.childCount).map { g.getChildAt(it) }.flatMap { if (it is ViewGroup) listOf(it) + all(it) else listOf(it) }
        return all(a.window.decorView as ViewGroup).filterIsInstance<WebView>().flatMap { Shadow.extract<PauseShadowWebView>(it).loads }
    }

    private fun open(intent: Intent) = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get().also { drainIo() }

    // An older yaran that lets this route in without a password: its page would later show its own form.
    @Test
    fun anOlderPasswordFreeMachineIsNeverShown() {
        val w = open(window("direct", A))
        assertTrue(w.isFinishing)
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertEquals(A, w.closedWith!!["host"])
        assertEquals(emptyList<String>(), loads(w))
    }

    // The same machine now asks for a password: no sheet, nothing posted, still no page.
    @Test
    fun anOlderMachineThatNowWantsAPasswordGetsNoSheet() {
        yaran.body = FakeYaran.capableStatus(capable = false).put("password_set", true).put("required_here", true)
        val w = open(window("direct", A))
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        assertEquals("one status probe, no login", 1, yaran.requests)
        assertEquals(emptyList<String>(), loads(w))
    }

    @Test
    fun anOrgWindowOfAnOlderMachineIsNeverShown() {
        val w = open(orgWindow(A))
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertEquals(emptyList<String>(), loads(w))
    }

    @Test
    fun anOrgWindowOfACompatibleMachineLoads() {
        yaran.body = FakeYaran.capableStatus()
        val w = open(orgWindow(A))
        assertEquals(listOf("https://$A/"), loads(w))
        assertNull(w.closedWith)
    }

    // Two routes, both older builds: the window says why rather than "no route".
    @Test
    fun aRoutedWindowOfOlderBuildsClosesUpgradeRequired() {
        val w = open(window("routes", A, B).putExtra("instance", "i1"))
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertEquals(emptyList<String>(), loads(w))
    }

    // A page admitted from a compatible build, then the machine is replaced by an older one:
    // neither a reload nor a resume probe admits its page.
    @Test
    fun aMachineThatLostTheCapabilityIsNotReloadedOrKept() {
        yaran.body = FakeYaran.capableStatus()
        val w = open(window("direct", A))
        assertEquals(listOf("https://$A/"), loads(w))
        yaran.body = FakeYaran.capableStatus(capable = false)
        w.load(w.state.url)
        drainIo()
        assertEquals("upgrade_required", w.closedWith!!["code"])
        assertEquals("no second load", listOf("https://$A/"), loads(w))

        yaran.body = FakeYaran.capableStatus()
        val again = open(window("direct", B))
        yaran.body = FakeYaran.capableStatus(capable = false)
        again.routes.select(again.state.chosen, retry = false)
        drainIo()
        assertEquals("upgrade_required", again.closedWith!!["code"])
    }
}
