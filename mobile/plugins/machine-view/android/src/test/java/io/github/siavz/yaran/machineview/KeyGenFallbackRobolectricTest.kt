/**
 * KeyGenFallbackRobolectricTest: StrongBox first, then the TEE, for both ways a StrongBox can
 * say no (`StrongBoxUnavailableException`, or a plain `ProviderException` from a broken
 * implementation, whose half-made entry is removed first). A TEE failure is not swallowed.
 * Robolectric supplies the real `android.security.keystore` exception classes.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.KeyGenFallbackRobolectricTest
 * └── io.github.siavz.yaran.machineview.AndroidKeyStoreBackend (inferred)
 * External: android.os, android.security.keystore, java.security, org.junit, org.junit.Assert, org.junit.runner, org.robolectric, org.robolectric.annotation
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.os.Build
import android.security.keystore.StrongBoxUnavailableException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.ProviderException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class KeyGenFallbackRobolectricTest {
    private val calls = mutableListOf<String>()

    private fun run(sdk: Int, strongBox: () -> Unit, tee: () -> Unit = {}) =
        KeyGenFallback.generate(sdk, { sb -> calls += if (sb) "strongbox" else "tee"; if (sb) strongBox() else tee() }, { calls += "cleanup" })

    @Test
    fun strongBoxWhenItWorks() {
        run(Build.VERSION_CODES.P, {})
        assertEquals(listOf("strongbox"), calls)
    }

    @Test
    fun noStrongBoxRetriesInTheTee() {
        run(Build.VERSION_CODES.P, { throw StrongBoxUnavailableException() })
        assertEquals(listOf("strongbox", "tee"), calls)
    }

    @Test
    fun aStrongBoxProviderFailureCleansUpThenRetriesInTheTee() {
        run(Build.VERSION_CODES.TIRAMISU, { throw ProviderException("Failed to generate key pair") })
        assertEquals(listOf("strongbox", "cleanup", "tee"), calls)
    }

    @Test
    fun beforePieOnlyTheTeeIsAsked() {
        run(Build.VERSION_CODES.O_MR1, { error("StrongBox must not be asked") })
        assertEquals(listOf("tee"), calls)
    }

    @Test
    fun aTeeFailureReachesTheCaller() {
        val thrown = runCatching { run(Build.VERSION_CODES.P, { throw StrongBoxUnavailableException() }, { throw ProviderException("tee broken") }) }
        assertTrue(thrown.exceptionOrNull() is ProviderException)
        assertEquals(listOf("strongbox", "tee"), calls)
    }
}
