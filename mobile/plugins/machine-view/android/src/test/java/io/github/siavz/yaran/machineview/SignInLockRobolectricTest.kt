/**
 * Robolectric checks that App Lock and the sign-in browser trip agree (review round 1, A).
 *
 * The real Activity lifecycle drives `ActivityForeground` and core's `LockTimer`; the real
 * handoff client writes the session through the real session store into a vault whose locked
 * class follows the lock. With the lock on and grace Immediately, a stop and restart around
 * the browser no longer relocks before the callback is stored, every other ending releases the
 * hold, the hold dies with the callback TTL, and an unlock whose credential screen stopped the
 * app does not relock on the way back.
 *
 * - Grace and time are the fake lock's clock; the handoff's own clock stays put.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SignInLockRobolectricTest
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: android.app, androidx.fragment.app, androidx.test.core.app, java.net, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.android.controller, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Application
import androidx.fragment.app.FragmentActivity
import androidx.test.core.app.ApplicationProvider
import io.github.siavz.yaran.core.LockGrace
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.net.URLDecoder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SignInLockRobolectricTest {
    private val host = "laptop-ada.example.com"
    private val clock = 1_731_571_200L
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val lock = FakeLock(enabled = true).also { it.vault = vault; it.grace = LockGrace.IMMEDIATELY }
    private val sessions = SessionStore(vault, lock, diag) { }
    private val keys = DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag)
    private val client = HandoffClient(vault, { "https://cp.example.com" }, sessions, keys, CallbackMode.Https("app.example.com"), "Ada's Pixel", { clock }, diag, lock)
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val tracker = lock.tracker()
    private lateinit var shell: ActivityController<FragmentActivity>

    @Before
    fun start() {
        app.registerActivityLifecycleCallbacks(tracker)
        shell = Robolectric.buildActivity(FragmentActivity::class.java).setup()
        assertFalse(lock.locked)
    }

    @After
    fun stop() = app.unregisterActivityLifecycleCallbacks(tracker)

    /** The browser in front of every activity of ours for [ms], then back. */
    private fun away(ms: Long) {
        shell.pause().stop()
        lock.now += ms
        shell.restart().resume()
    }

    private fun begin(): Map<String, String> =
        (client.begin("org1", SignInTarget.Machine(host)) as Begin.Launch).url.substringAfter('?').split('&')
            .associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }

    private fun callback(q: Map<String, String>): String {
        val jwe = TestSealer.seal(q.getValue("pk"), host, q.getValue("state"), TestSealer.payload("machine", host, clock + 86_400, clock))
        return "https://app.example.com/auth/callback?state=${q["state"]}&jwe=$jwe"
    }

    @Test
    fun theBrowserTripDoesNotRelockBeforeTheCallbackIsStored() {
        val q = begin()
        away(5 * 60_000L) // a slow Access one-time PIN
        assertFalse("back from the app's own sign-in browser", lock.locked)
        assertEquals(SignInOutcome.SignedIn(host, "ada@example.org", clock + 86_400), client.onRedirect(callback(q)))
        assertEquals(ProtectionClass.LOCKED, vault.classes["${SessionStore.PREFIX}$host"])
        assertEquals("org1", sessions.get(host)!!.orgId)

        away(0)
        assertTrue("stored and released: a real background still locks at once", lock.locked)
        assertTrue(runCatching { sessions.get(host) }.exceptionOrNull() is VaultLockedException)
    }

    @Test
    fun everyOtherEndingReleasesTheHold() {
        val endings: List<Pair<String, (Map<String, String>) -> SignInOutcome?>> = listOf(
            "cancelled" to { _ -> client.onCancelled() },
            "verification failed" to { _ -> client.onVerificationFailed() },
            "no browser" to { _ -> client.onNoBrowser() },
            "declined" to { q -> client.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&error=handoff_declined") },
            "mismatch" to { _ -> client.onRedirect("https://app.example.com/auth/callback?state=${"A".repeat(43)}&jwe=x.y") },
        )
        for ((name, end) in endings) {
            lock.locked = false
            val q = begin()
            assertTrue(name, end(q) !is SignInOutcome.SignedIn)
            away(0)
            assertTrue("$name released the hold", lock.locked)
        }
    }

    @Test
    fun aLongGraceTripSignsInAndAnAbandonedHoldDiesWithTheTtl() {
        lock.grace = LockGrace.ONE_MINUTE
        val q = begin()
        away(2 * 60_000L)
        assertEquals(SignInOutcome.SignedIn(host, "ada@example.org", clock + 86_400), client.onRedirect(callback(q)))
        assertFalse(lock.locked)

        begin()
        away(CallbackUrl.TTL_S * 1000 + 1)
        assertTrue("a flow that never reported back cannot keep App Lock off", lock.locked)
        assertEquals(SignInOutcome.Cancelled, client.onCancelled())
    }

    @Test
    fun anUnlockWhoseCredentialScreenStoppedTheAppDoesNotRelock() {
        away(0)
        assertTrue(lock.locked)
        // A credential screen in its own activity: our stop, the unlock landing, then our start.
        shell.pause().stop()
        lock.unlock(shell.get()) { }
        shell.restart().resume()
        assertFalse(lock.locked)
    }
}
