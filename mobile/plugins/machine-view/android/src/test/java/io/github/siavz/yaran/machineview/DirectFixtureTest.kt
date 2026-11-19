/**
 * DirectFixtureTest: the direct-machine wire rules, session record and route choice against
 * the fixtures the Swift twin reads too (`fixtures/direct-cases.json`, and the protocol's
 * `fixtures/uri/add-machine.json` for the public-host rule).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.DirectFixtureTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.Fixtures
 * └── io.github.siavz.yaran.machineview.RouteSelector (inferred)
 * External: org.json, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.machineview.Fixtures.objects
import io.github.siavz.yaran.machineview.Fixtures.optStringOrNull
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DirectFixtureTest {
    private val f = Fixtures.plugin("direct-cases.json")

    private fun body(c: JSONObject) = c.optStringOrNull("body_text") ?: c.optJSONObject("body")?.toString() ?: ""

    private fun js(m: Map<String, Any?>) = JSONObject().apply { m.forEach { (k, v) -> put(k, v ?: JSONObject.NULL) } }

    private fun assertSameJson(name: String, want: JSONObject, got: JSONObject) {
        assertEquals(name, want.keys().asSequence().toSet(), got.keys().asSequence().toSet())
        for (k in want.keys()) assertEquals("$name: $k", want.get(k).toString(), got.get(k).toString())
    }

    @Test
    fun statusAnswers() {
        for (c in f.getJSONArray("status").objects()) {
            val got = DirectWire.classifyStatus(c.getInt("status"), c.optStringOrNull("location"), c.optStringOrNull("content_type"), body(c))
            assertSameJson(c.getString("name"), c.getJSONObject("want"), js(got.toJs()))
        }
    }

    @Test
    fun loginAnswers() {
        for (c in f.getJSONArray("login").objects()) {
            val name = c.getString("name")
            val got = DirectWire.classifyLogin(c.getInt("status"), c.optStringOrNull("location"), c.optStringOrNull("content_type"), body(c))
            val want = c.getJSONObject("want")
            when (got) {
                is LoginAnswer.Token -> {
                    assertEquals(name, "signed_in", want.getString("kind"))
                    assertEquals(name, c.getJSONObject("store").getString("token"), got.token)
                    assertEquals(name, c.getJSONObject("store").getString("cookie_name"), got.cookieName)
                    assertFalse("a token never prints", got.toString().contains(got.token))
                }
                is LoginAnswer.Failed -> {
                    assertSameJson(name, want, js(got.outcome.toJs()))
                    if (c.has("revoke")) assertEquals(name, c.getBoolean("revoke"), got.revoke != null)
                }
            }
        }
        val long = f.getJSONObject("long_message")
        val raw = long.getString("repeat").repeat(long.getInt("times"))
        assertEquals(long.getInt("want_length"), DirectWire.cleanMessage(raw).length)
    }

    @Test
    fun sessionCookie() {
        for (c in f.getJSONArray("cookie").objects()) {
            val token = if (c.has("token_length")) "a".repeat(c.getInt("token_length")) else c.getString("token")
            val got = DirectWire.setCookie(c.getString("name"), token)
            if (c.optBoolean("set_cookie_ok")) assertTrue(c.toString(), got != null) else assertEquals(c.toString(), c.optStringOrNull("set_cookie"), got)
        }
    }

    @Test
    fun publicHostsFollowTheProtocolRule() {
        val rows = Fixtures.protocol("fixtures/uri/add-machine.json").getJSONArray("build").objects()
        assertTrue(rows.size > 5)
        for (r in rows) assertEquals(r.getString("host"), !r.isNull("expect"), DirectWire.isPublicHost(r.getString("host")))
    }

    @Test
    fun routeChoice() {
        for (c in f.getJSONArray("routes").objects()) {
            val probes = c.getJSONArray("probes").let { a -> (0 until a.length()).map { Probe.valueOf(a.getString(it).uppercase()) } }
            val probed = mutableListOf<Int>()
            val current = if (c.getString("mode") == "open") null else c.getInt("current")
            val got = RouteSelector.select(probes.size, current) { probed += it; probes[it] }
            val want = c.getJSONObject("want")
            val expected = when (want.getString("kind")) {
                "chosen" -> Selection.Chosen(want.getInt("index"))
                "kept" -> Selection.Kept(want.getInt("index"))
                "sign_in_first" -> Selection.SignInFirst(want.getInt("index"))
                "no_route" -> Selection.NoRoute
                else -> fail("unknown kind").let { Selection.NoRoute }
            }
            assertEquals(c.getString("name"), expected, got)
            c.optJSONArray("probed")?.let { a -> assertEquals(c.getString("name"), (0 until a.length()).map { a.getInt(it) }, probed) }
        }
    }

    @Test
    fun aStatusAgainstTheRecordedInstance() {
        val y = DirectStatus.Yaran("i1", true, true, false, true)
        assertEquals(Probe.MATCH_SIGN_IN, RouteSelector.probeOf(y, "i1"))
        assertEquals(Probe.MISMATCH, RouteSelector.probeOf(y, "i2"))
        assertEquals(Probe.MATCH, RouteSelector.probeOf(y.copy(signedIn = true), null))
        assertEquals(Probe.MATCH, RouteSelector.probeOf(y.copy(requiredHere = false), "i1"))
        assertEquals(Probe.UNREACHABLE, RouteSelector.probeOf(DirectStatus.AccessRequired, "i1"))
    }

    @Test
    fun theLoginBodyCarriesThePasswordExactlyAndNothingElse() {
        val pw = "p\"w\\d\u0001é😀".toCharArray()
        val bytes = DirectWire.loginBody(pw, "yaran phone (Ada's \"Pixel\")")
        val o = JSONObject(String(bytes, Charsets.UTF_8))
        assertEquals(setOf("password", "label"), o.keys().asSequence().toSet())
        assertEquals(String(pw), o.getString("password"))
        assertEquals("yaran phone (Ada's \"Pixel\")", o.getString("label"))
    }

    @Test
    fun theSessionRecordStaysNativeAndSaysWhenItIsUnreadable() {
        val vault = FakeVault()
        val lock = FakeLock(enabled = false).also { it.vault = vault } // App Lock off: the record is locked class anyway
        val store = DirectSessionStore(vault)
        val s = DirectSession("yaran.example.com", "tok_EN-1", "yaran_session_443", "inst-1", 7)
        store.put(s)
        assertEquals(listOf("session-direct/yaran.example.com"), vault.data.keys.toList())
        assertEquals("locked class from creation", ProtectionClass.LOCKED, vault.classes["session-direct/yaran.example.com"])
        assertTrue("the namespace is under the reserved session prefix", DirectSessionStore.PREFIX.startsWith("session"))
        val back = store.get("yaran.example.com")!!
        assertEquals(listOf("tok_EN-1", "yaran_session_443", "inst-1"), listOf(back.token, back.cookieName, back.instance))
        assertFalse(back.toString().contains("tok_EN-1"))
        assertNull(store.get("other.example.com"))
        assertEquals(listOf("yaran.example.com"), store.hosts())

        lock.locked = true
        assertThrows<VaultLockedException> { store.get("yaran.example.com") }
        assertTrue("a locked record still exists", store.has("yaran.example.com"))
        lock.locked = false

        vault.data["session-direct/yaran.example.com"] = "{not json".toByteArray()
        assertThrows<DirectRecordUnreadableException> { store.get("yaran.example.com") }
        vault.data["session-direct/yaran.example.com"] = JSONObject().put("host", "evil.example.com").put("token", "t").put("cookie_name", "yaran_session_443")
            .put("instance", JSONObject.NULL).put("issued_at", 1).toString().toByteArray()
        assertThrows<DirectRecordUnreadableException> { store.get("yaran.example.com") }
        val broken = object : SecretVault by vault {
            override fun read(ns: String): ByteArray? = throw IllegalStateException("tampered")
        }
        assertThrows<DirectRecordUnreadableException> { DirectSessionStore(broken).get("yaran.example.com") }
        store.delete("yaran.example.com")
        assertNull(store.get("yaran.example.com"))
    }

    private inline fun <reified T : Throwable> assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (e: Throwable) {
            if (e is T) return
            throw AssertionError("expected ${T::class.simpleName}, got ${e.javaClass.simpleName}", e)
        }
        throw AssertionError("expected ${T::class.simpleName}, nothing was thrown")
    }
}
