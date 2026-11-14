/**
 * Fixture pins for the handoff URL builder and the callback validator.
 *
 * `handoff-url-cases.json` fixes every byte of the URL; 02's `uri/handoff-redirect.json`
 * proves each build's redirect is accepted for that build and refused for the other;
 * `callback-cases.json` covers both callback forms, both parameter placements, every error
 * shape and every refusal.
 *
 * - Pure JVM.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffUrlFixtureTest
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.Fixtures
 * └── io.github.siavz.yaran.machineview.HandoffUrl (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.machineview.Fixtures.objects
import io.github.siavz.yaran.machineview.Fixtures.optStringOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HandoffUrlFixtureTest {
    private fun mode(c: org.json.JSONObject) =
        if (c.getString("mode") == "https") CallbackMode.Https(c.getString("domain")) else CallbackMode.Dev

    @Test
    fun handoffUrls() {
        for (c in Fixtures.cases(Fixtures.plugin("handoff-url-cases.json"))) {
            val target = if (c.getString("target") == "machine") HandoffTarget.Machine(c.getString("host"))
            else HandoffTarget.ControlPlane(c.getString("org_url"))
            val p = c.getJSONObject("params")
            val url = HandoffUrl.build(target, mode(c), c.getBoolean("fragment"), c.getString("device"),
                HandoffParams(p.getString("pk"), p.getString("state"), p.getString("dk"), p.getString("dts").toLong(), p.getString("dsig")))
            assertEquals(c.getString("name"), c.getString("expect_url"), url)
            assertEquals(c.getString("name"), c.getString("signed_host"), HandoffUrl.signedHost(target))
            assertTrue(url.contains("&dk=") && url.contains("&dts=") && url.contains("&dsig="))
        }
    }

    @Test
    fun eachBuildsRedirectIsAllowedOnlyForItsBuild() {
        val cases = Fixtures.cases(Fixtures.protocol("fixtures/uri/handoff-redirect.json"))
        fun expect(redirect: String, build: String) = cases.single { it.getString("redirect") == redirect && it.optStringOrNull("build") == build }.getBoolean("expect")
        val release = HandoffUrl.redirect(CallbackMode.Https("app.example.com"))
        val dev = HandoffUrl.redirect(CallbackMode.Dev)
        assertTrue(expect(release, "release"))
        assertTrue(expect(dev, "dev"))
        assertEquals(false, expect(release, "dev"))
        assertEquals(false, expect(dev, "release"))
    }

    @Test
    fun callbacks() {
        val f = Fixtures.plugin("callback-cases.json")
        assertEquals(f.getLong("ttl_s"), CallbackUrl.TTL_S)
        for (c in Fixtures.cases(f)) {
            val pending = if (c.isNull("pending")) null else c.getJSONObject("pending").let { PendingRef(it.getString("state"), it.getLong("created_at")) }
            val got = CallbackUrl.parse(mode(c), c.getString("uri"), pending, c.getLong("now"))
            val e = c.getJSONObject("expect")
            val name = c.getString("name")
            when (e.getString("result")) {
                "success" -> assertEquals(name, CallbackResult.Success(e.getString("jwe")), got)
                "error" -> assertEquals(name, CallbackResult.Error(
                    e.getString("code"),
                    if (e.has("min")) e.getInt("min") else null,
                    if (e.has("max")) e.getInt("max") else null,
                    if (e.has("server_time")) e.getLong("server_time") else null,
                ), got)
                else -> assertEquals(name, CallbackResult.Refused(CallbackRefusal.valueOf(e.getString("reason").uppercase())), got)
            }
        }
        assertEquals("Success(jwe=<redacted>)", CallbackResult.Success("x..y.z.w").toString())
    }

}
