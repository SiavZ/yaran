/**
 * AuthTabRegistryRobolectricTest: an Auth Tab result is told which launch it belongs to by the
 * AndroidX ActivityResultRegistry itself (Sol native review round 8), never by arrival order.
 *
 * Sign-ins run through `SignInFlow` and a real `BrowserLauncher` on a real `ComponentActivity`;
 * results are dispatched through `activityResultRegistry.dispatchResult` with the request codes
 * the launches really got, in either order. A replaced launch's late redirect, verification
 * failure or cancel ends nothing and keeps the current launch's hold; the current launch ends
 * once, from its own result, and a launch that finds no browser ends only itself.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.AuthTabRegistryRobolectricTest
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.content, android.net, android.os, androidx.activity, androidx.browser.auth, androidx.test.core.app, java.net, java.time, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.Shadows, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.os.Looper
import androidx.activity.ComponentActivity
import androidx.browser.auth.AuthTabIntent
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.net.URLDecoder
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuthTabRegistryRobolectricTest {
    private val host = "laptop-ada.example.com"
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val app get() = ApplicationProvider.getApplicationContext<android.app.Application>()
    private val rt get() = PluginRuntime.get(app)
    private val lock = Holds()
    private lateinit var controller: org.robolectric.android.controller.ActivityController<ComponentActivity>
    private lateinit var activity: ComponentActivity
    private lateinit var launcher: BrowserLauncher

    /** Counts App Lock holds, so "released exactly once" is checkable. */
    private class Holds : AppLockState by FakeLock() {
        var held = 0

        override fun holdForExternalFlow(ttlMs: Long) {
            held++
        }

        override fun releaseExternalFlow() {
            if (held > 0) held--
        }
    }

    @Before
    fun bindings() {
        CoreBindings.install(CoreBindings(TestBindings.vault, FakeDiagnostics(), { "https://cp.example.com" }, TestBindings.lock, { false }))
        rt.handoff = HandoffClient(vault, { "https://cp.example.com" }, SessionStore(vault, diag) { },
            DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag), CallbackMode.Https("app.example.com"), "Pixel",
            { System.currentTimeMillis() / 1000 }, diag, lock)
        BrowserLauncher.detect = { BrowserLauncher.Browser.AuthTab("com.example.browser") }
        controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
        activity = controller.get()
        launcher = BrowserLauncher(activity)
    }

    @After
    fun real() {
        BrowserLauncher.detect = { BrowserLauncher.Browser.None }
    }

    private fun drain() {
        repeat(4) {
            rt.io.submit {}.get()
            shadowOf(Looper.getMainLooper()).idle()
        }
    }

    /** Starts a sign-in through the real flow; returns its request code, its state and its outcomes. */
    private fun start(): Triple<Int, String, MutableList<SignInOutcome>> {
        val outcomes = mutableListOf<SignInOutcome>()
        SignInFlow.start(activity, launcher, "org1", SignInTarget.Machine(host)) { outcomes += it }
        drain()
        val launched = shadowOf(activity).nextStartedActivityForResult
        val url = launched.intent.data.toString()
        val state = URLDecoder.decode(url.substringAfter("state=").substringBefore('&'), "UTF-8")
        return Triple(launched.requestCode, state, outcomes)
    }

    private fun dispatch(requestCode: Int, resultCode: Int, uri: String? = null) {
        activity.activityResultRegistry.dispatchResult(requestCode, resultCode, uri?.let { Intent().setData(Uri.parse(it)) })
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4)) // past a cancel's grace
        drain()
    }

    private fun declined(state: String) = "https://app.example.com/auth/callback?state=$state&error=handoff_declined"

    @Test
    fun theReplacedLaunchsResultsEndNothingWhicheverArrivesFirst() {
        val (rcA, stateA, a) = start()
        val (rcB, stateB, b) = start()
        assertEquals("A was replaced, once", listOf<SignInOutcome>(SignInOutcome.Cancelled), a)
        assertEquals("A gave its hold back; B holds", 1, lock.held)
        // A answers late in every way it can, before B does: nothing of B ends.
        dispatch(rcA, AuthTabIntent.RESULT_VERIFICATION_FAILED)
        dispatch(rcA, AuthTabIntent.RESULT_CANCELED)
        dispatch(rcA, AuthTabIntent.RESULT_OK, declined(stateA))
        assertEquals(emptyList<SignInOutcome>(), b)
        assertEquals(1, lock.held)
        dispatch(rcB, AuthTabIntent.RESULT_OK, declined(stateB))
        assertEquals("B ends once, from its own result", listOf<SignInOutcome>(SignInOutcome.Declined), b)
        assertEquals(0, lock.held)
    }

    // Round 9: A's own registry entry answers RESULT_OK with a URI that names B's state. It is
    // A's result whatever the URI claims: B is not ended, keeps its hold, and ends once from its own.
    @Test
    fun aReplacedLaunchsRedirectClaimingTheCurrentStateEndsNothing() {
        val (rcA, _, _) = start()
        val (rcB, stateB, b) = start()
        dispatch(rcA, AuthTabIntent.RESULT_OK, declined(stateB))
        assertEquals(emptyList<SignInOutcome>(), b)
        assertEquals(1, lock.held)
        dispatch(rcB, AuthTabIntent.RESULT_OK, declined(stateB))
        assertEquals(listOf<SignInOutcome>(SignInOutcome.Declined), b)
        assertEquals(0, lock.held)
    }

    @Test
    fun theCurrentLaunchsResultArrivingFirstIsStillItsOwn() {
        val (rcA, _, _) = start()
        val (rcB, _, b) = start()
        dispatch(rcB, AuthTabIntent.RESULT_VERIFICATION_FAILED) // B first: AndroidX does not promise launch order
        assertEquals(listOf<SignInOutcome>(SignInOutcome.VerificationFailed("app.example.com")), b)
        assertEquals(0, lock.held)
        dispatch(rcA, AuthTabIntent.RESULT_CANCELED)
        dispatch(rcA, AuthTabIntent.RESULT_VERIFICATION_FAILED)
        assertEquals("A's late answers change nothing", 1, b.size)
        assertEquals(0, lock.held)
    }

    @Test
    fun aLaunchThatFindsNoBrowserEndsOnlyItself() {
        val (rcA, _, _) = start()
        BrowserLauncher.detect = { BrowserLauncher.Browser.None }
        val outcomes = mutableListOf<SignInOutcome>()
        SignInFlow.start(activity, launcher, "org1", SignInTarget.Machine(host)) { outcomes += it }
        drain()
        assertEquals(listOf<SignInOutcome>(SignInOutcome.NoBrowser), outcomes)
        assertEquals(0, lock.held)
        dispatch(rcA, AuthTabIntent.RESULT_CANCELED)
        assertEquals("A's late cancel reaches nobody", 1, outcomes.size)
        assertEquals(0, lock.held)
    }

    // The activity is recreated while the Auth Tab is up (a rotation): its restored registry and
    // the new launcher's registration under the awaited launch's key still deliver the result.
    @Test
    fun aRecreatedActivityStillHearsTheAwaitedLaunch() {
        val (rc, state, outcomes) = start()
        controller.recreate()
        activity = controller.get()
        launcher = BrowserLauncher(activity)
        dispatch(rc, AuthTabIntent.RESULT_OK, declined(state))
        assertEquals(listOf<SignInOutcome>(SignInOutcome.Declined), outcomes)
        assertEquals(0, lock.held)
    }
}
