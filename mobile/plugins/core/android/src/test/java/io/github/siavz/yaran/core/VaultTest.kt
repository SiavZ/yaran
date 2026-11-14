/**
 * VaultTest: JUnit coverage of the vault's storage, integrity and lock-class behaviour.
 *
 * Runs on the JVM with [SoftwareKeyProvider] in a temporary directory, so the encryption,
 * file layout and error mapping are exercised without a device.
 *
 * - Round trip in both protection classes, listing, removal and erase.
 * - Tampering (flipped byte, truncation, a blob moved to another namespace) is an explicit
 *   `tampered` error, never an empty result.
 * - The lock flow: wrap under the lock, relock, unlock, and the invalidation path that wipes
 *   the locked class while leaving standard entries alone.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.VaultTest
 * ├── io.github.siavz.yaran.core.SoftwareKeyProvider (inferred)
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: java.io, javax.crypto, org.junit, org.junit.Assert, org.junit.rules
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import javax.crypto.Cipher

class VaultTest {
    @get:Rule val temp = TemporaryFolder()

    private val keys = SoftwareKeyProvider()
    private val dir: File by lazy { temp.newFolder("vault") }
    private val vault: Vault by lazy { Vault(dir, keys) }

    @Test
    fun roundTripsBothProtectionClasses() {
        vault.set("orgs", "list", """{"orgs":[]}""", Protection.STANDARD)
        vault.set("orgs", "secret", "s3cr3t ✓", Protection.LOCKED)
        assertEquals("""{"orgs":[]}""", vault.get("orgs", "list"))
        assertEquals("s3cr3t ✓", vault.get("orgs", "secret"))
        assertEquals(listOf("list", "secret"), vault.list("orgs"))
        assertNull(vault.get("orgs", "missing"))
        // A fresh instance over the same files and keys reads the same values.
        assertEquals("s3cr3t ✓", Vault(dir, keys).get("orgs", "secret"))
    }

    @Test
    fun removeAndEraseAll() {
        vault.set("orgs", "a", "1", Protection.STANDARD)
        vault.set("prefs", "b", "2", Protection.STANDARD)
        vault.remove("orgs", "a")
        assertEquals(emptyList<String>(), vault.list("orgs"))
        vault.eraseAll()
        assertEquals(emptyList<String>(), vault.list("prefs"))
        assertTrue(dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun valuesAreNotStoredInTheClear() {
        vault.set("orgs", "list", "plain-marker", Protection.STANDARD)
        val bytes = File(dir, "orgs.bin").readBytes().decodeToString(throwOnInvalidSequence = false)
        assertFalse(bytes.contains("plain-marker"))
    }

    @Test
    fun aFlippedByteIsTamperedNotEmpty() {
        vault.set("orgs", "list", "value", Protection.STANDARD)
        val file = File(dir, "orgs.bin")
        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        file.writeBytes(bytes)
        assertEquals("tampered", assertThrows(CoreError::class.java) { vault.get("orgs", "list") }.code)
        assertThrows(CoreError.Tampered::class.java) { vault.list("orgs") }
    }

    @Test
    fun aTruncatedBlobIsTampered() {
        vault.set("orgs", "list", "value", Protection.STANDARD)
        File(dir, "orgs.bin").writeBytes(ByteArray(5))
        assertThrows(CoreError.Tampered::class.java) { vault.get("orgs", "list") }
    }

    @Test
    fun namespacesAreIsolated() {
        vault.set("alpha", "k", "a", Protection.STANDARD)
        vault.set("beta", "k", "b", Protection.STANDARD)
        assertEquals("a", vault.get("alpha", "k"))
        assertEquals("b", vault.get("beta", "k"))
        // A blob copied under another namespace's name fails its associated-data check.
        File(dir, "alpha.bin").copyTo(File(dir, "beta.bin"), overwrite = true)
        assertThrows(CoreError.Tampered::class.java) { vault.get("beta", "k") }
        assertEquals("a", vault.get("alpha", "k"))
    }

    @Test
    fun namesThatCouldEscapeTheDirectoryAreRefused() {
        listOf("../x", "UPPER", "", "a".repeat(33), "a/b").forEach { namespace ->
            assertThrows(CoreError.InvalidArgument::class.java) { vault.set(namespace, "k", "v", Protection.STANDARD) }
        }
        listOf("", "a b", "k/1", "x".repeat(65)).forEach { key ->
            assertThrows(CoreError.InvalidArgument::class.java) { vault.get("ok", key) }
        }
    }

    @Test
    fun theLockGuardsTheLockedClassUntilUnlocked() {
        vault.set("sessions-x", "standard", "s", Protection.STANDARD)
        vault.set("sessions-x", "locked", "l", Protection.LOCKED)
        enableLock()
        assertTrue(vault.isLockWrapped())

        vault.relock()
        assertFalse(vault.isUnlocked())
        assertEquals("locked", assertThrows(CoreError::class.java) { vault.get("sessions-x", "locked") }.code)
        assertThrows(CoreError.Locked::class.java) { vault.set("sessions-x", "other", "v", Protection.LOCKED) }
        assertEquals("s", vault.get("sessions-x", "standard"))
        assertEquals(listOf("locked", "standard"), vault.list("sessions-x"))

        vault.unlock(vault.lockCipherForUnlock())
        assertEquals("l", vault.get("sessions-x", "locked"))

        // Disabling re-wraps under the standard key; a fresh process reads without a prompt.
        vault.wrapUnderStandard()
        vault.deleteLockKey()
        assertFalse(vault.isLockWrapped())
        assertEquals("l", Vault(dir, keys).get("sessions-x", "locked"))
    }

    @Test
    fun invalidationWipesTheLockedClassAndSaysSo() {
        vault.set("orgs", "standard", "kept", Protection.STANDARD)
        vault.set("orgs", "locked", "gone", Protection.LOCKED)
        enableLock()
        vault.relock()
        keys.invalidate()

        assertEquals("invalidated", assertThrows(CoreError::class.java) { vault.lockCipherForUnlock() }.code)
        assertFalse(vault.isLockWrapped())
        assertFalse(keys.hasLockKey)
        assertEquals(listOf("standard"), vault.list("orgs"))
        assertEquals("kept", vault.get("orgs", "standard"))
        // The locked class starts over under a new standard-wrapped data key.
        vault.set("orgs", "locked", "new", Protection.LOCKED)
        assertEquals("new", vault.get("orgs", "locked"))
    }

    @Test
    fun aTamperedDataKeyIsTampered() {
        vault.set("orgs", "locked", "v", Protection.LOCKED)
        val file = File(dir, "locked.key")
        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        file.writeBytes(bytes)
        assertThrows(CoreError.Tampered::class.java) { Vault(dir, keys).get("orgs", "locked") }
    }

    private fun enableLock() {
        val cipher: Cipher = vault.lockCipherForEnable(allowDeviceCredential = false)
        vault.wrapUnderLock(cipher)
    }
}
