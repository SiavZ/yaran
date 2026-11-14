/**
 * Fixture-driven JUnit pins for the pure policy twins of the machine window.
 *
 * Navigation, control URLs, routes, renewal, refusals (fixture and registry), device labels,
 * cookies, the UA token and the failure table: every case of every shared table, named on
 * failure. The Swift suite reads the same files.
 *
 * - Pure JVM: no Android runtime, no network.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.PolicyFixtureTest
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.ControlUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceLabel (inferred)
 * ├── io.github.siavz.yaran.machineview.Fixtures
 * ├── io.github.siavz.yaran.machineview.InsetsMode (inferred)
 * ├── io.github.siavz.yaran.machineview.Messages (inferred)
 * ├── io.github.siavz.yaran.machineview.RefusalPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.RouteFragment (inferred)
 * └── io.github.siavz.yaran.machineview.UaToken (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit and Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/machine-view/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.machineview.Fixtures.objects
import io.github.siavz.yaran.machineview.Fixtures.optLongOrNull
import io.github.siavz.yaran.machineview.Fixtures.optStringOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyFixtureTest {
    @Test
    fun navigation() {
        val f = Fixtures.plugin("navigation-cases.json")
        val host = f.getString("host")
        val cases = Fixtures.cases(f)
        assertTrue(cases.size >= 60)
        for (c in cases) {
            val d = NavigationPolicy.decide(host, c.getString("url"), c.getString("frame") == "main", c.getBoolean("new_window"), c.getBoolean("gesture"))
            assertEquals(c.getString("name"), c.getString("expect"), d.action.name.lowercase())
            assertEquals(c.getString("name") + " diagnostic", c.getBoolean("diagnostic"), d.diagnostic)
        }
    }

    @Test
    fun controlUrls() {
        for (c in Fixtures.cases(Fixtures.protocol("fixtures/uri/control-urls.json"))) {
            val d = ControlUrl.decide(c.getString("uri"), c.getString("loaded_host"))
            val got = when (d) {
                ControlDecision.Reauth -> "reauth"
                ControlDecision.Home -> "home"
                ControlDecision.Settings -> "settings"
                is ControlDecision.Ignore -> "ignore"
            }
            assertEquals(c.getString("uri"), c.getString("expect"), got)
            if (c.optStringOrNull("code") == "uri_invalid") assertEquals(c.getString("uri"), ControlDecision.Ignore(true), d)
        }
    }

    @Test
    fun routes() {
        for (c in Fixtures.cases(Fixtures.plugin("routes.json"))) {
            assertEquals(c.getString("route"), c.getBoolean("expect"), RouteFragment.isValid(c.getString("route")))
        }
    }

    @Test
    fun renewal() {
        val f = Fixtures.plugin("renewal-cases.json")
        val k = f.getJSONObject("constants")
        assertEquals(k.getLong("pre_open_max_s"), RenewalPolicy.PRE_OPEN_MAX_S)
        assertEquals(k.getLong("pre_open_divisor"), RenewalPolicy.PRE_OPEN_DIVISOR)
        assertEquals(k.getLong("banner_s"), RenewalPolicy.BANNER_S)
        for (c in Fixtures.cases(f)) {
            val ctx = RenewalContext.valueOf(c.getString("context").uppercase())
            val d = RenewalPolicy.decide(c.getLong("now"), c.optLongOrNull("iat"), c.getLong("exp"), ctx, c.getBoolean("visible"))
            val e = c.getJSONObject("expect")
            assertEquals(c.getString("name"), e.getString("action"), d.action.name.lowercase())
            assertEquals(c.getString("name") + " next", e.optLongOrNull("next_check_at"), d.nextCheckAt)
        }
    }

    @Test
    fun refusals() {
        for (c in Fixtures.cases(Fixtures.plugin("refusal-cases.json"))) {
            val d = RefusalPolicy.decide(c.getInt("status"), c.optStringOrNull("refusal"))
            val e = c.getJSONObject("expect")
            assertEquals(c.getString("name"), e.getString("decision"), d.overlay.name.lowercase())
            assertEquals(c.getString("name") + " diagnostic", e.getBoolean("diagnostic"), d.diagnostic)
        }
    }

    @Test
    fun everyRegistryRefusalIsKnown() {
        val registry = Fixtures.protocol("registry/refusals.json").getJSONArray("refusals").objects()
        assertEquals(RefusalPolicy.KNOWN, registry.map { it.getString("code") }.toSet())
        for (r in registry) {
            val d = RefusalPolicy.decide(r.getInt("status"), r.getString("code"))
            assertFalse(r.getString("code"), d.diagnostic)
            assertTrue(r.getString("code"), d.overlay != RefusalOverlay.NONE && d.overlay != RefusalOverlay.CODE_OVERLAY)
        }
    }

    @Test
    fun deviceLabels() {
        val f = Fixtures.plugin("device-labels.json")
        assertEquals(f.getString("fallback"), DeviceLabel.FALLBACK)
        for (c in Fixtures.cases(f)) {
            assertEquals(c.getString("name"), c.getString("expect"), DeviceLabel.clean(c.optStringOrNull("name_in"), c.getString("model")))
        }
    }

    @Test
    fun cookies() {
        val f = Fixtures.plugin("cookie-cases.json")
        assertEquals(f.getJSONArray("clear").let { a -> (0 until a.length()).map { a.getString(it) } }, CookieSpec.clearCookies)
        assertEquals("https://h.example.com/", CookieSpec.cookieUrl("h.example.com"))
        for (c in Fixtures.cases(f)) {
            val rung = CredentialKind.fromWire(c.getString("credential_kind"))!!
            val got = CookieSpec.setCookie(c.getString("jwt"), c.optStringOrNull("cookie"), rung)
            val e = c.getJSONObject("expect")
            if (e.has("error")) {
                assertNull(c.getString("name"), got)
                continue
            }
            got!!
            assertEquals(c.getString("name"), e.getString("set_cookie"), got.setCookie)
            assertEquals(c.getString("name"), e.getString("used") == "cookie", got.usedCookieField)
            assertEquals(c.getString("name"), e.getBoolean("diagnostic"), got.diagnostic)
        }
    }

    @Test
    fun uaToken() {
        for (c in Fixtures.cases(Fixtures.protocol("fixtures/ua/ua.json"), "build")) {
            val i = c.getJSONObject("input")
            assertEquals(c.getString("token"), UaToken.token(i.getString("version"), i.getString("os"), i.getString("form")))
        }
        assertEquals("tablet", UaToken.formFor(600))
        assertEquals("phone", UaToken.formFor(599))
    }

    @Test
    fun messagesMatchTheSharedTable() {
        val f = Fixtures.plugin("messages.json")
        val signIn = f.getJSONObject("sign_in")
        assertEquals(signIn.keys().asSequence().toSet(), Messages.signIn.keys)
        for (k in signIn.keys().asSequence().toSet()) {
            val row = signIn.getJSONObject(k)
            assertEquals(k, Messages.Row(row.getString("message"), row.getString("action")), Messages.signIn[k])
        }
        val overlay = f.getJSONObject("overlay")
        assertEquals(overlay.keys().asSequence().toSet(), Messages.overlay.keys)
        for (k in overlay.keys().asSequence().toSet()) {
            val row = overlay.getJSONObject(k)
            val actions = row.getJSONArray("actions").let { a -> (0 until a.length()).map { a.getString(it) } }
            assertEquals(k, Messages.OverlayRow(row.getString("message"), actions), Messages.overlay[k])
        }
        assertEquals("ada isn't the owner of m.", Messages.fill(Messages.signIn.getValue("not_owner").message, mapOf("email" to "ada", "machine" to "m")))
    }

    @Test
    fun insetsMode() {
        assertEquals(InsetsMode.PASS_THROUGH, InsetsMode.forWebViewVersion("144.0.7559.0", false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS, InsetsMode.forWebViewVersion("143.0.1", false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS, InsetsMode.forWebViewVersion("139.0.1", false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS_AND_IME, InsetsMode.forWebViewVersion("138.9", false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS_AND_IME, InsetsMode.forWebViewVersion(null, false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS_AND_IME, InsetsMode.forWebViewVersion("garbage", false))
        assertEquals(InsetsMode.PAD_SYSTEM_BARS_AND_IME, InsetsMode.forWebViewVersion("150.0", true))
    }

    @Test
    fun b64url() {
        for (n in 0..8) {
            val bytes = ByteArray(n) { (it * 37 + 200).toByte() }
            assertTrue(bytes.contentEquals(B64url.decode(B64url.encode(bytes))))
        }
        assertNull(B64url.decode("ab=="))
        assertNull(B64url.decode("a"))
        assertNull(B64url.decode("ab+c"))
        assertNull(B64url.decode("AB"))
    }
}
