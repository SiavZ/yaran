/**
 * AppLockPolicyTest: the grace-period table of `AppLock.shouldLock`, the grace codes, and
 * [LockTimer]'s external-flow hold and unlock-voids-the-mark rules.
 *
 * The decision is pure, so it is tested exhaustively at the boundaries of every grace value
 * without a device or a biometric prompt.
 *
 * - A clock that runs backwards locks (fail closed); a hold never outlives its TTL.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.AppLockPolicyTest
 * └── io.github.siavz.yaran.core.AppLock (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockPolicyTest {
    @Test
    fun shouldLockTable() {
        val t0 = 1_000_000L
        val table =
            listOf(
                Triple(LockGrace.IMMEDIATELY, 0L, true),
                Triple(LockGrace.IMMEDIATELY, 1L, true),
                Triple(LockGrace.ONE_MINUTE, 59_999L, false),
                Triple(LockGrace.ONE_MINUTE, 60_000L, true),
                Triple(LockGrace.FIVE_MINUTES, 299_999L, false),
                Triple(LockGrace.FIVE_MINUTES, 300_000L, true),
                Triple(LockGrace.FIFTEEN_MINUTES, 899_999L, false),
                Triple(LockGrace.FIFTEEN_MINUTES, 900_000L, true),
                Triple(LockGrace.FIFTEEN_MINUTES, -1L, true),
            )
        table.forEach { (grace, elapsed, expected) ->
            assertEquals("$grace after ${elapsed}ms", expected, AppLock.shouldLock(t0, t0 + elapsed, grace))
        }
    }

    @Test
    fun graceCodesMatchTheTypeScriptContract() {
        assertEquals(listOf("immediately", "1min", "5min", "15min"), LockGrace.entries.map { it.code })
        assertEquals(LockGrace.ONE_MINUTE, LockGrace.DEFAULT)
        assertEquals(null, LockGrace.parse("2min"))
    }

    @Test
    fun anExternalFlowHoldsTheLockOpenOnlyUntilItEndsOrItsTtl() {
        val t = LockTimer()
        t.hold(nowMs = 1_000, ttlMs = 600_000)
        t.background(2_000)
        assertFalse("back from the sign-in browser, even immediately-grace", t.foreground(300_000, LockGrace.IMMEDIATELY))
        t.release()
        t.background(400_000)
        assertTrue("released: the background lock applies again", t.foreground(400_000, LockGrace.IMMEDIATELY))

        t.hold(nowMs = 1_000_000, ttlMs = 600_000)
        t.background(1_000_000)
        assertTrue("a hold nobody released expires with its TTL", t.foreground(1_600_001, LockGrace.FIVE_MINUTES))
        t.background(1_100_000)
        assertTrue("a clock that went backwards is outside the hold and locks", t.foreground(999_999, LockGrace.FIFTEEN_MINUTES))
    }

    @Test
    fun theMarkIsConsumedOnceAndAnUnlockVoidsIt() {
        val t = LockTimer()
        assertFalse("a cold start is AppLock's job, not the timer's", t.foreground(5_000, LockGrace.IMMEDIATELY))
        t.background(1_000)
        assertTrue(t.foreground(1_000, LockGrace.IMMEDIATELY))
        assertFalse(t.foreground(2_000, LockGrace.IMMEDIATELY))
        t.background(3_000)
        t.present()
        assertFalse("a credential screen that stopped the app before the unlock landed", t.foreground(90_000, LockGrace.IMMEDIATELY))
    }
}
