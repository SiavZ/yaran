/**
 * Renewal wiring with an injected clock and scheduler (work item 9).
 *
 * Pre-open renewal, the banner at exp - 10 min, the overlay at exp with the socket still open,
 * a reauth from the control URL (Phase 13's path after a 4401), a renewal that succeeds and
 * reloads the same URL, and one that fails and keeps the overlay.
 *
 * - Pure JVM.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.RenewalCoordinatorTest
 * ├── io.github.siavz.yaran.machineview.CookieSpec (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.RenewalCoordinator (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenewalCoordinatorTest {
    private var now = 1_000_000L
    private var exp = now + 86_400
    private val events = mutableListOf<String>()
    private var scheduled: Pair<Long?, () -> Unit>? = null
    private var renewResult: SignInOutcome = SignInOutcome.SignedIn("h", "e", 0)

    private val ui = object : RenewalUi {
        override fun showBanner() { events += "banner" }
        override fun hideBanner() { events += "-banner" }
        override fun showReauthOverlay() { events += "overlay" }
        override fun hideOverlay() { events += "-overlay" }
        override fun reloadSameUrl() { events += "reload" }
    }

    private val c = RenewalCoordinator(
        session = { Session("o", "a.b.c", null, exp, exp - 86_400, "e", CredentialKind.ACCESS_JWT) },
        now = { now },
        scheduler = { at, task -> scheduled = at to task },
        ui = ui,
        renew = { done -> if (renewResult is SignInOutcome.SignedIn) exp = now + 86_400; done(renewResult) },
    )

    private fun fire() {
        val (at, task) = scheduled!!
        now = at!!
        task()
    }

    @Test
    fun preOpenRenewal() {
        assertFalse(c.onOpen())
        now = exp - 3600
        assertTrue(c.onOpen())
        assertTrue(c.onResume())
    }

    @Test
    fun bannerThenOverlayAtExpByWallClock() {
        c.evaluate()
        assertEquals(exp - 600, scheduled!!.first)
        fire()
        assertEquals("banner", events.last())
        assertEquals(exp, scheduled!!.first)
        fire()
        assertEquals("overlay", events.last())
    }

    @Test
    fun resumeAfterSleepPastExpRenewsBeforeLoad() {
        c.evaluate()
        now = exp + 10
        assertTrue(c.onResume())
    }

    @Test
    fun reauthSignalShowsTheOverlay() {
        c.onReauthSignal()
        assertEquals(listOf("-banner", "overlay"), events)
        assertEquals(null, scheduled!!.first)
    }

    @Test
    fun successfulRenewalReloadsTheSameUrl() {
        now = exp
        c.evaluate()
        var got: SignInOutcome? = null
        c.renewNow { got = it }
        assertTrue(got is SignInOutcome.SignedIn)
        assertTrue(events.containsAll(listOf("-overlay", "reload")))
        assertEquals(exp - 600, scheduled!!.first)
    }

    @Test
    fun failedRenewalKeepsTheOverlayAndReportsTheOutcome() {
        now = exp
        c.evaluate()
        renewResult = SignInOutcome.Cancelled
        var got: SignInOutcome? = null
        c.renewNow { got = it }
        assertEquals(SignInOutcome.Cancelled, got)
        assertFalse(events.contains("-overlay"))
        assertEquals("overlay", events.last())
    }

    @Test
    fun hiddenWindowDoesNothingUntilVisible() {
        c.onVisibilityChanged(false)
        assertEquals(null, scheduled!!.first)
        now = exp + 1
        c.onVisibilityChanged(true)
        assertEquals("overlay", events.last())
    }
}
