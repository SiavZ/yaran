/**
 * The Android payload parser and topic against 02's `push/payload-parse.json`,
 * `push/payload-events.json` and `push/payload-topic.json`, plus display sanitizing.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.push.PushPayloadParserTest
 * ├── io.github.siavz.yaran.push.Fixtures (inferred)
 * └── io.github.siavz.yaran.push.PushPayloadParser (inferred)
 * External: org.junit, org.junit.Assert, org.junit.runner, org.robolectric
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/push/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PushPayloadParserTest {
    @Test
    fun parseFixture() {
        for (c in Fixtures.objects(Fixtures.json("fixtures/push/payload-parse.json").getJSONArray("cases"))) {
            val parsed = PushPayloadParser.parse(c.getString("utf8").toByteArray(Charsets.UTF_8))
            assertEquals(c.getString("name"), c.getString("expect") == "ok", parsed != null)
        }
    }

    @Test
    fun everyEventFixtureParsesToItsFields() {
        val cases = Fixtures.objects(Fixtures.json("fixtures/push/payload-events.json").getJSONArray("cases"))
        assert(cases.size >= 18)
        val tokens = mutableSetOf<String>()
        for (c in cases) {
            val expected = c.getJSONObject("payload")
            val parsed = PushPayloadParser.parse(c.getString("serialized").toByteArray(Charsets.UTF_8))
            assertNotNull(c.getString("name"), parsed)
            val push = parsed!!.agent!!
            assertEquals(expected.getString("k"), parsed.kind)
            assertEquals(expected.getString("m"), push.machineId)
            assertEquals(expected.getString("a"), push.agentId)
            assertEquals(expected.optString("t").ifEmpty { null }, push.tabId)
            assertEquals(expected.getString("s"), push.token)
            assertEquals(expected.optString("p").ifEmpty { null }, push.project)
            assertEquals(expected.optString("l").ifEmpty { null }, push.label)
            tokens += push.token
        }
        // Every RowState token after a clear and every ending token appears.
        assertEquals(
            setOf("needs_attention", "typing", "busy", "idle", "detached", "exited", "launch_failed", "exited_unknown", "rapid_clean_exit"),
            tokens,
        )
    }

    @Test
    fun strictnessBeyondTheFixture() {
        val base = """{"v":1,"k":"attention_raised","m":"6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b","a":"x","s":"needs_attention","ts":1"""
        assertNotNull(PushPayloadParser.parse("$base}".toByteArray()))
        assertNull(PushPayloadParser.parse("""$base,"t":null}""".toByteArray()))
        assertNull(PushPayloadParser.parse("""$base,"p":""}""".toByteArray()))
        assertNull(PushPayloadParser.parse("""{"v":true,"k":"test","ts":1}""".toByteArray()))
        assertNull(PushPayloadParser.parse("""{"v":1,"k":"test","ts":1.5}""".toByteArray()))
        assertNull(PushPayloadParser.parse(byteArrayOf(0xff.toByte(), 0xfe.toByte())))
        assertNull(PushPayloadParser.parse(ByteArray(321) { ' '.code.toByte() }))
    }

    @Test
    fun topicFixture() {
        for (t in Fixtures.objects(Fixtures.json("fixtures/push/payload-topic.json").getJSONArray("topics"))) {
            val tab = if (t.isNull("t")) null else t.getString("t")
            assertEquals(t.getString("topic"), pushTopic(t.getString("m"), t.getString("a"), tab))
        }
    }

    @Test
    fun twoAgentsSlotTabsOnOneMachineGetTwoTags() {
        val m = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
        assertNotEquals(pushTopic(m, "agent-1", null), pushTopic(m, "agent-2", null))
    }

    @Test
    fun displayStripsControlAndBidi() {
        assertEquals("fixgnp.exe", displayText("fix‮gnp.exe"))
        assertEquals("a[31mb", displayText("a\u001B[31mb\u0007"))
        assertEquals("日本語", displayText("日本語"))
    }
}
