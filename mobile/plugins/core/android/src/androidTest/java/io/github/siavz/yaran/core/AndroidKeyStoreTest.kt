/**
 * AndroidKeyStoreTest: instrumented checks of the vault on a real AndroidKeyStore.
 *
 * Needs a device or emulator (`./gradlew :yaran-core:connectedDebugAndroidTest`). It proves
 * what the JVM suite cannot: the keystore round trip, and that the keys carry the flags the
 * design depends on, read back through `KeyInfo`.
 *
 * - The lock-key test is skipped on a device without a secure lock screen, where the
 *   keystore refuses to create an auth-bound key.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.AndroidKeyStoreTest
 * ├── io.github.siavz.yaran.core.KeyProvider (inferred)
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: android.app, android.content, android.os, android.security.keystore, androidx.test.ext.junit.runners, androidx.test.platform.app, java.io, org.junit, org.junit.Assert, org.junit.Assume, org.junit.runner
 *
 * Used by: entry point (instrumented test, via ./gradlew connectedAndroidTest in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class AndroidKeyStoreTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val keys = AndroidKeyStoreKeyProvider(context)
    private val dir = File(context.noBackupFilesDir, "vault-test")

    @After
    fun cleanUp() {
        keys.deleteAll()
        dir.deleteRecursively()
    }

    @Test
    fun roundTripsThroughTheKeystore() {
        val vault = Vault(dir, keys)
        vault.set("orgs", "list", "value", Protection.STANDARD)
        vault.set("orgs", "secret", "locked value", Protection.LOCKED)
        assertEquals("value", Vault(dir, keys).get("orgs", "list"))
        assertEquals("locked value", Vault(dir, keys).get("orgs", "secret"))
    }

    @Test
    fun theStandardKeyNeedsNoUserAuthentication() {
        keys.standardKey()
        val info = keys.keyInfo(lockKey = false) ?: error("standard key missing")
        assertFalse(info.isUserAuthenticationRequired)
        assertEquals(256, info.keySize)
    }

    @Test
    fun theLockKeyIsAuthPerUseAndInvalidatedByEnrolment() {
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        assumeTrue("needs a secure lock screen", keyguard.isDeviceSecure)
        keys.createLockKey(allowDeviceCredential = true)
        val info = keys.keyInfo(lockKey = true) ?: error("lock key missing")
        assertTrue(info.isUserAuthenticationRequired)
        assertTrue(info.isInvalidatedByBiometricEnrollment)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            assertEquals(0, info.userAuthenticationValidityDurationSeconds)
            assertEquals(
                KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                info.userAuthenticationType,
            )
        }
    }
}
