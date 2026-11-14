/**
 * AppLockPolicyTest: the grace-period table of `AppLock.shouldLock` and the grace codes.
 *
 * The decision is pure, so it is tested exhaustively at the boundaries of every grace value
 * without a device or a biometric prompt.
 *
 * - A clock that runs backwards locks (fail closed).
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
}
