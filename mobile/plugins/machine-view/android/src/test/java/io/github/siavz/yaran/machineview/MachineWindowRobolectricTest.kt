/**
 * Robolectric checks of the Android machine window (work item 7).
 *
 * The factory applies every setting of the configuration table and adds no JS bridge; the
 * back callback is enabled exactly while the WebView can go back; saved state round-trips the
 * same-host URL and drops a foreign one; the chooser keeps only `content://` results; and a
 * window with bad arguments closes with an error instead of loading anything.
 *
 * - Robolectric's WebView is a shadow: settings and history are observable, rendering is not.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineWindowRobolectricTest
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineChromeClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewFactory (inferred)
 * └── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * External: android.content, android.net, android.os, android.view, android.webkit, androidx.test.core.app, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import android.view.ViewGroup
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertArrayEquals
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class MachineWindowRobolectricTest {
    @Before
    fun bindings() {
        CoreBindings.install(CoreBindings(FakeVault(), FakeDiagnostics(), { "https://cp.example.com" }, FakeLock(), { false }))
    }

    @Test
    fun factoryAppliesTheHardenedSettings() {
        val w = MachineWebViewFactory.create(ApplicationProvider.getApplicationContext(), false, "YaranApp/1.0.0 (android; phone)")
        val s = w.settings
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        assertFalse(s.supportMultipleWindows())
        assertFalse(s.javaScriptCanOpenWindowsAutomatically)
        assertTrue(s.userAgentString.endsWith(" YaranApp/1.0.0 (android; phone)"))
    }

    @Suppress("DEPRECATION") // ShadowWebView.setCanGoBack is the only way to fake history.
    @Test
    fun backCallbackFollowsCanGoBack() {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MachineViewActivity::class.java)
            .putExtra("orgId", "org1").putExtra("machineId", "m1").putExtra("host", "laptop-ada.example.com")
        val activity = Robolectric.buildActivity(MachineViewActivity::class.java, intent).setup().get()
        val web = findWebView(activity.window.decorView as ViewGroup)!!
        assertFalse(activity.backCallback.isEnabled)
        shadowOf(web).setCanGoBack(true)
        activity.onHistoryChanged("https://laptop-ada.example.com/#/agent/a")
        assertTrue(activity.backCallback.isEnabled)
        shadowOf(web).setCanGoBack(false)
        activity.onHistoryChanged("https://laptop-ada.example.com/")
        assertFalse(activity.backCallback.isEnabled)
    }

    @Test
    fun badArgumentsCloseWithoutLoading() {
        val intent = Intent(ApplicationProvider.getApplicationContext(), MachineViewActivity::class.java)
            .putExtra("orgId", "org1").putExtra("machineId", "m1").putExtra("host", "Bad_Host")
        val activity = Robolectric.buildActivity(MachineViewActivity::class.java, intent).create().get()
        assertTrue(activity.isFinishing)
    }

    @Test
    fun savedStateRoundTrip() {
        val s = MachineState.of("org1", "m1", "laptop-ada.example.com", "#/agent/a/tab/t")!!
        assertEquals("https://laptop-ada.example.com/#/agent/a/tab/t", s.url)
        val b = Bundle()
        s.copy(url = "https://laptop-ada.example.com/#/agent/b").toBundle(b)
        assertEquals(s.copy(url = "https://laptop-ada.example.com/#/agent/b"), MachineState.fromBundle(b))
        val foreign = Bundle()
        s.copy(url = "https://evil.example.net/").toBundle(foreign)
        assertNull(foreign.getString(MachineState.K_URL))
        assertEquals(MachineState.root("laptop-ada.example.com"), MachineState.fromBundle(foreign)!!.url)
        assertNull(MachineState.of("org1", "m1", "laptop-ada.example.com", "#/agent/../x"))
    }

    @Test
    fun chooserKeepsOnlyContentUris() {
        val c = Uri.parse("content://media/1")
        assertArrayEquals(arrayOf(c), MachineChromeClient.contentOnly(arrayOf(c, Uri.parse("file:///etc/passwd"))))
        assertNull(MachineChromeClient.contentOnly(arrayOf(Uri.parse("file:///x"))))
        assertNull(MachineChromeClient.contentOnly(null))
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
