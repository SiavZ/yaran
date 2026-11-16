/**
 * Robolectric checks of the Android machine window (work item 7).
 *
 * The factory applies every setting of the configuration table and adds no JS bridge; the
 * back callback is enabled exactly while the WebView can go back; saved state round-trips the
 * same-host URL and drops a foreign one; the chooser keeps only `content://` results; and a
 * window with bad arguments closes with an error instead of loading anything; the app-wide
 * lock tracking covers an open machine resumed after the grace period until it is unlocked,
 * with the overlay and banner under the cover out of TalkBack's reach and inert; and a window
 * restored locked after process death reads no session and loads nothing until the unlock,
 * then starts exactly once; and a renderer crash under the cover attaches a page TalkBack cannot
 * reach and loads nothing until the unlock reloads it.
 *
 * - Robolectric's WebView is a shadow: settings and history are observable, rendering is not.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.MachineWindowRobolectricTest
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineChromeClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWebViewFactory (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, android.content, android.net, android.os, android.view, android.webkit, android.widget, androidx.test.core.app, org.json, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.view.ViewGroup
import android.widget.Button
import androidx.test.core.app.ApplicationProvider
import android.os.Looper
import io.github.siavz.yaran.core.LockGrace
import io.github.siavz.yaran.core.LockTimer
import org.json.JSONObject
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
        lock.apply {
            enabled = false
            locked = false
            prompts = 0
            promptUnlocks = true
            now = 0L
            grace = LockGrace.ONE_MINUTE
            timer = LockTimer()
        }
        vault.apply {
            data.clear()
            classes.clear()
            reads.clear()
            locked = false
        }
        CoreBindings.install(CoreBindings(vault, FakeDiagnostics(), { "https://cp.example.com" }, lock, { false }))
    }

    // PluginRuntime is one per process and outlives a test, so every test drives this one lock and vault.
    private companion object {
        val lock = FakeLock()
        val vault = FakeVault()
        const val HOST = "laptop-ada.example.com"
    }

    private fun machineIntent() = Intent(ApplicationProvider.getApplicationContext(), MachineViewActivity::class.java)
        .putExtra("orgId", "org1").putExtra("machineId", "m1").putExtra("host", HOST)

    /** A signed-in machine, so a start loads the page instead of renewing. */
    private fun storeSession() {
        val now = System.currentTimeMillis() / 1000
        vault.data["${SessionStore.PREFIX}$HOST"] = JSONObject().put("org_id", "org1").put("jwt", TestSealer.jwt(now + 86_400))
            .put("exp", now + 86_400).put("iat", now).put("email", "ada@example.org").toString().toByteArray()
    }

    /** Runs what the window queued on its io thread and the main-thread replies, in order. */
    private fun drainIo() {
        repeat(2) {
            PluginRuntime.get(ApplicationProvider.getApplicationContext()).io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
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
    fun anOpenMachineBackgroundedPastTheGraceIsCoveredUntilUnlocked() {
        lock.enabled = true
        lock.promptUnlocks = false
        storeSession()
        // The production wiring (AppLock.trackActivities) over core's own LockTimer.
        val tracker = lock.tracker()
        val app = ApplicationProvider.getApplicationContext<Application>()
        app.registerActivityLifecycleCallbacks(tracker)
        try {
            val shell = Robolectric.buildActivity(Activity::class.java).setup()
            val machine = Robolectric.buildActivity(MachineViewActivity::class.java, machineIntent()).create().start()
            shell.pause().stop()
            machine.resume()
            drainIo()
            assertFalse("the shell stopping behind a machine window is not leaving the app", lock.timer.foreground(Long.MAX_VALUE, LockGrace.IMMEDIATELY))
            machine.get().showReauthOverlay()
            machine.get().showBanner()

            machine.pause().stop()
            lock.now = 3 * 60_000L
            machine.start().resume()
            val decor = machine.get().window.decorView as ViewGroup
            val web = findWebView(decor)!!
            assertTrue(lock.locked)
            assertEquals(1, lock.prompts)
            assertTrue(onScreen(findButton(decor, "Unlock")!!))
            val signIn = findButton(decor, "Sign in")!!
            val renew = findButton(decor, "Renew")!!
            for (v in listOf(web, signIn.rootUnder(decor), renew.rootUnder(decor))) {
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, v.importantForAccessibility)
            }
            vault.reads.clear()
            signIn.performClick()
            renew.performClick()
            drainIo()
            assertFalse("Sign in and Renew behind the cover start nothing", vault.reads.any { it.startsWith("install/") })

            machine.pause().resume()
            assertEquals("a cancelled prompt is not shown again on every resume", 1, lock.prompts)

            val unlock = findButton(decor, "Unlock")!!
            lock.promptUnlocks = true
            unlock.performClick()
            assertFalse(lock.locked)
            assertFalse(onScreen(unlock))
            for (v in listOf(web, signIn.rootUnder(decor), renew.rootUnder(decor))) {
                assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, v.importantForAccessibility)
            }
        } finally {
            app.unregisterActivityLifecycleCallbacks(tracker)
        }
    }

    @Test
    fun aWindowRestoredLockedStartsOnlyOnceAfterTheUnlock() {
        lock.enabled = true
        lock.locked = true // a fresh process: AppLock starts locked when the lock is enabled
        lock.promptUnlocks = false
        storeSession()
        val machine = Robolectric.buildActivity(MachineViewActivity::class.java, machineIntent()).create().start().resume()
        drainIo()
        val decor = machine.get().window.decorView as ViewGroup
        val web = findWebView(decor)!!
        assertEquals(1, lock.prompts)
        assertTrue(onScreen(findButton(decor, "Unlock")!!))
        assertTrue("no session refresh before the unlock", vault.reads.none { it.startsWith(SessionStore.PREFIX) })
        assertTrue("no sign-in browser before the unlock", vault.reads.none { it.startsWith("install/") })
        assertNull("no page load before the unlock", shadowOf(web).lastLoadedUrl)

        lock.promptUnlocks = true
        val unlock = findButton(decor, "Unlock")!!
        unlock.performClick()
        unlock.performClick() // a second unlock before the first start lands must not start again
        drainIo()
        assertEquals("started once", 1, vault.reads.count { it == "${SessionStore.PREFIX}$HOST" })
        assertEquals("https://$HOST/", shadowOf(web).lastLoadedUrl)
        assertTrue(vault.reads.none { it.startsWith("install/") })
    }

    @Test
    fun aRendererCrashUnderTheCoverLoadsNothingUntilTheUnlock() {
        lock.enabled = true
        storeSession()
        val machine = Robolectric.buildActivity(MachineViewActivity::class.java, machineIntent()).create().start().resume()
        drainIo()
        val decor = machine.get().window.decorView as ViewGroup
        assertEquals("https://$HOST/", shadowOf(findWebView(decor)!!).lastLoadedUrl)

        lock.locked = true
        lock.promptUnlocks = false
        machine.pause().resume()
        assertTrue(onScreen(findButton(decor, "Unlock")!!))
        machine.get().onRendererGone(findWebView(decor)!!)
        drainIo()
        val fresh = findWebView(decor)!!
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS, fresh.importantForAccessibility)
        assertNull("no page or session behind the cover", shadowOf(fresh).lastLoadedUrl)

        lock.promptUnlocks = true
        findButton(decor, "Unlock")!!.performClick()
        drainIo()
        assertEquals(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO, fresh.importantForAccessibility)
        assertEquals("the unlock reloads the page", "https://$HOST/", shadowOf(fresh).lastLoadedUrl)
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

    /** The direct child of the window's content that holds [this] (the overlay or banner itself). */
    private fun View.rootUnder(decor: ViewGroup): View {
        val content = decor.findViewById<ViewGroup>(android.R.id.content).getChildAt(0)
        return generateSequence(this) { it.parent as? View }.first { it.parent === content }
    }

    // Robolectric attaches no window here, so View.isShown is unusable; every ancestor visible is the same claim.
    private fun onScreen(v: View) = generateSequence(v) { it.parent as? View }.all { it.visibility == View.VISIBLE }

    private fun findButton(g: ViewGroup, label: String): Button? {
        for (i in 0 until g.childCount) {
            when (val v = g.getChildAt(i)) {
                is Button -> if (v.text == label) return v
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
