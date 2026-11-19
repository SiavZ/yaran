/**
 * ShareBatchRobolectricTest: a press acts on the share it was made for (G5; share-batch contract).
 *
 * Calls go through the real `MachineViewPlugin` methods with real `PluginCall`s (a recording
 * message handler stands in for the WebView bridge). A share A is shown and its batch captured;
 * share B arrives before the queued command runs, as Capacitor's plugin thread allows; A's
 * Send or Discard is then refused `share_changed` and B stays held, its event still waiting.
 * Controls: the current batch is taken or discarded, nothing held, malformed or missing ids,
 * and the old `share: true` refused rather than opening a window without its files.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.ShareBatchRobolectricTest
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.ShareHolder (inferred)
 * └── io.github.siavz.yaran.machineview.WindowEvents (inferred)
 * External: android.content, android.net, androidx.appcompat.app, com.getcapacitor, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import androidx.appcompat.app.AppCompatActivity
import com.getcapacitor.Bridge
import com.getcapacitor.JSObject
import com.getcapacitor.MessageHandler
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginResult
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ShareBatchRobolectricTest {
    /** A real PluginCall's resolve or reject, as the bridge would send it. */
    class Recorder : MessageHandler(null, null, null) {
        var answers: MutableList<Pair<Boolean, JSObject?>>? = null

        override fun sendResponseMessage(call: PluginCall, successResult: PluginResult?, errorResult: PluginResult?) {
            answers!!.add((errorResult == null) to (successResult ?: errorResult)?.let { JSObject(it.toString()) })
        }
    }

    private lateinit var activity: AppCompatActivity
    private lateinit var plugin: MachineViewPlugin
    private val recorder = unsafe(Recorder::class.java).also { it.answers = mutableListOf() }

    private companion object {
        fun <T> unsafe(type: Class<T>): T {
            val u = Class.forName("sun.misc.Unsafe")
            val instance = u.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
            @Suppress("UNCHECKED_CAST")
            return u.getMethod("allocateInstance", Class::class.java).invoke(instance, type) as T
        }
    }

    @Before
    fun plugin() {
        ShareHolder.discard()
        activity = Robolectric.buildActivity(AppCompatActivity::class.java).create().get().also {
            it.setTheme(androidx.appcompat.R.style.Theme_AppCompat)
        }
        val bridge = unsafe(Bridge::class.java)
        Bridge::class.java.getDeclaredField("context").apply { isAccessible = true }.set(bridge, activity)
        plugin = MachineViewPlugin().apply { setBridge(bridge) }
    }

    @After
    fun clear() = ShareHolder.discard()

    private fun share(vararg uris: String) = assertTrue(ShareHolder.intake(Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(
        Intent.EXTRA_STREAM, ArrayList(uris.map(Uri::parse)))))

    /** Runs [method] with [data] as JS would; returns (resolved, its object). */
    private fun call(method: String, data: JSObject): Pair<Boolean, JSObject?> {
        val call = PluginCall(recorder, "MachineView", "cb-$method", method, data)
        when (method) {
            "open" -> plugin.open(call)
            "discardShare" -> plugin.discardShare(call)
            "shareStatus" -> plugin.shareStatus(call)
        }
        return recorder.answers!!.removeAt(0)
    }

    private fun status() = call("shareStatus", JSObject()).second!!

    private fun open(vararg extra: Pair<String, Any>) = call("open", JSObject().put("orgId", "https://cp.example.com").put("machineId", "m1")
        .put("host", "laptop-ada.example.com").apply { extra.forEach { (k, v) -> put(k, v) } })

    private fun code(answer: Pair<Boolean, JSObject?>) = answer.second?.getString("code")

    @Test
    fun aPressForShareANeverTakesShareB() {
        share("content://media/a1")
        val shown = status()
        assertEquals("pending", shown.getString("kind"))
        val a = shown.getString("batch")!!
        share("content://media/b1", "content://media/b2") // arrives before A's queued Send runs
        val refused = open("shareBatch" to a)
        assertEquals(false, refused.first)
        assertEquals("share_changed", code(refused))
        assertNull("no window opened", shadowOf(activity).nextStartedActivity)
        val now = status()
        assertEquals(2, now.getInt("count"))
        val b = now.getString("batch")!!
        assertTrue(b != a)
        val sent = open("shareBatch" to b)
        assertEquals(true, sent.first)
        val clip = shadowOf(activity).nextStartedActivity.clipData!!
        assertEquals(listOf("content://media/b1", "content://media/b2"), (0 until clip.itemCount).map { clip.getItemAt(it).uri.toString() })
        assertEquals("none", status().getString("kind"))
    }

    @Test
    fun aDiscardForShareALeavesShareBAndItsEvent() {
        share("content://media/a1")
        val a = status().getString("batch")!!
        share("content://media/b1")
        val waiting = ShareHolder.waiting()
        val refused = call("discardShare", JSObject().put("batch", a))
        assertEquals("share_changed", code(refused))
        assertEquals(1, status().getInt("count"))
        assertEquals("B's event still waits to be told", waiting, ShareHolder.waiting())
        val b = status().getString("batch")!!
        assertEquals(true, call("discardShare", JSObject().put("batch", b)).first)
        assertEquals("none", status().getString("kind"))
        assertNull(ShareHolder.waiting())
    }

    @Test
    fun theCurrentShareIsTakenAndNothingHeldIsTruthful() {
        share("content://media/a1")
        val a = status().getString("batch")!!
        assertEquals(true, open("shareBatch" to a).first)
        assertEquals("content://media/a1", shadowOf(activity).nextStartedActivity.clipData!!.getItemAt(0).uri.toString())
        assertEquals("no_share", code(open("shareBatch" to a)))
        assertEquals("discarding what is gone is done", true, call("discardShare", JSObject().put("batch", a)).first)
    }

    @Test
    fun malformedIdsAndTheOldShareFlagAreRefused() {
        share("content://media/a1")
        for (bad in listOf("", "a1", "../x", "8d1c9a7e-3b0f-4b8e-9a51-2f6c0d4e7b13x")) {
            assertEquals(bad, "invalid_arguments", code(open("shareBatch" to bad)))
            assertEquals(bad, "invalid_arguments", code(call("discardShare", JSObject().put("batch", bad))))
        }
        assertEquals("invalid_arguments", code(call("discardShare", JSObject())))
        assertEquals("invalid_arguments", code(open("share" to true)))
        assertNull(shadowOf(activity).nextStartedActivity)
        assertEquals("the files stay", 1, status().getInt("count"))
    }
}
