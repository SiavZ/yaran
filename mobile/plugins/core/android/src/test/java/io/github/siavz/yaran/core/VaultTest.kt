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

    // A session token an older build wrote while the lock was off must not stay readable once it is on.
    @Test
    fun enablingTheLockMovesLegacySessionEntriesIntoTheLockedClass() {
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD)
        vault.set("session-direct", "names", "a.example.com", Protection.STANDARD)
        vault.set("session", "h2", "access-jwt", Protection.STANDARD)
        vault.set("orgs", "list", "[]", Protection.STANDARD)
        enableLock()
        val relaunched = Vault(dir, keys) // a new process: the lock is wrapped and nothing is unlocked
        assertThrows(CoreError.Locked::class.java) { relaunched.get("session-direct", "h1") }
        assertThrows(CoreError.Locked::class.java) { relaunched.get("session", "h2") }
        assertEquals("the host index stays listable", "a.example.com", relaunched.get("session-direct", "names"))
        assertEquals("other namespaces keep their class", "[]", relaunched.get("orgs", "list"))
        val raw = File(dir, "session-direct.bin").readBytes().decodeToString(throwOnInvalidSequence = false)
        assertFalse(raw.contains("direct-token"))
    }

    @Test
    fun aFailedPromotionLeavesTheLockOffAndEveryEntryReadable() {
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD)
        File(dir, "session.bin").writeBytes(ByteArray(64) { 7 })
        val cipher = vault.lockCipherForEnable(allowDeviceCredential = false)
        assertThrows(CoreError.Tampered::class.java) { vault.wrapUnderLock(cipher) }
        assertFalse(vault.isLockWrapped())
        assertEquals("direct-token", Vault(dir, keys).get("session-direct", "h1"))
    }

    // A lock an older build enabled never promoted its session entries: they are refused while
    // locked, and the first unlock moves them into the locked class.
    @Test
    fun aLockEnabledByAnOlderBuildRefusesThenPromotesLegacySessions() {
        enableLock()
        // What the older build wrote while unlocked, after its lock was on.
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD)
        vault.set("session-direct", "names", "a.example.com", Protection.STANDARD)
        vault.set("session", "h2", "access-jwt", Protection.STANDARD)
        val relaunched = Vault(dir, keys)
        assertThrows(CoreError.Locked::class.java) { relaunched.get("session-direct", "h1") }
        assertThrows(CoreError.Locked::class.java) { relaunched.get("session", "h2") }
        assertEquals("a.example.com", relaunched.get("session-direct", "names"))
        relaunched.unlock(relaunched.lockCipherForUnlock())
        assertEquals("nothing lost at the unlock", "direct-token", relaunched.get("session-direct", "h1"))
        // Promoted: the locked-class wipe now takes them, and the host index stays.
        relaunched.wipeLocked()
        assertNull(relaunched.get("session-direct", "h1"))
        assertNull(relaunched.get("session", "h2"))
        assertEquals("a.example.com", relaunched.get("session-direct", "names"))
    }

    // Round 4: the lock key is invalidated before any unlock could promote an older build's
    // standard session entries; losing the lock must take them as it takes the locked class.
    @Test
    fun anInvalidationBeforePromotionDropsLegacySessions() {
        enableLock()
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD)
        vault.set("session-direct", "names", "a.example.com", Protection.STANDARD)
        vault.set("session", "h2", "access-jwt", Protection.STANDARD)
        vault.set("orgs", "list", "[]", Protection.STANDARD)
        vault.relock()
        keys.invalidate()
        val relaunched = Vault(dir, keys)
        assertEquals("invalidated", assertThrows(CoreError::class.java) { relaunched.lockCipherForUnlock() }.code)
        assertEquals(listOf("names"), relaunched.list("session-direct"))
        assertEquals(emptyList<String>(), relaunched.list("session"))
        assertEquals("a.example.com", relaunched.get("session-direct", "names"))
        assertEquals("[]", relaunched.get("orgs", "list"))
    }

    // Round 5: the invalidation's cleanup cannot rewrite a session namespace (its temp file
    // path is taken). The wipe must fail as itself, not as a finished invalidation, and a
    // restart must still see the lock and refuse the legacy secret until a retry completes.
    @Test
    fun aFailedInvalidationCleanupKeepsTheLockUntilARetryFinishesIt() {
        enableLock()
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD)
        vault.set("session-direct", "names", "a.example.com", Protection.STANDARD)
        vault.relock()
        keys.invalidate()
        val blocker = File(dir, "session-direct.bin.tmp").apply { mkdirs() }
        assertThrows(CoreError.Unavailable::class.java) { Vault(dir, keys).lockCipherForUnlock() }

        val restarted = Vault(dir, keys)
        assertTrue("the lock is still on", restarted.isLockWrapped())
        assertThrows(CoreError.Locked::class.java) { restarted.get("session-direct", "h1") }
        assertEquals("a.example.com", restarted.get("session-direct", "names"))

        blocker.delete()
        assertEquals("invalidated", assertThrows(CoreError::class.java) { Vault(dir, keys).lockCipherForUnlock() }.code)
        val wiped = Vault(dir, keys)
        assertFalse(wiped.isLockWrapped())
        assertEquals(listOf("names"), wiped.list("session-direct"))
    }

    // Round 8: the wipe cannot delete the lock marker (the vault directory refuses writes). The
    // key must stay with it, the failure must not read as a finished invalidation, and once the
    // directory accepts writes again a restart retries and completes it.
    @Test
    fun aMarkerThatCannotBeDeletedKeepsItsKeyUntilARetryFinishes() {
        vault.set("orgs", "list", "[]", Protection.STANDARD)
        enableLock()
        vault.relock()
        keys.invalidate()
        assertTrue(dir.setWritable(false))
        try {
            assertThrows(CoreError.Unavailable::class.java) { Vault(dir, keys).lockCipherForUnlock() }
        } finally {
            dir.setWritable(true)
        }
        assertTrue("the key stayed with its marker", keys.hasLockKey)
        val restarted = Vault(dir, keys)
        assertTrue(restarted.isLockWrapped())
        assertEquals("invalidated", assertThrows(CoreError::class.java) { restarted.lockCipherForUnlock() }.code)
        assertFalse(Vault(dir, keys).isLockWrapped())
        assertFalse(keys.hasLockKey)
        assertEquals("[]", Vault(dir, keys).get("orgs", "list"))
    }

    // Round 10: an older build's partial save left a standard session secret with no `names`
    // index, so the wipe empties the namespace, and the filesystem refuses to unlink it. That is
    // not a finished invalidation: the marker and key stay, a restart still refuses the secret,
    // and a retry once the file can be removed completes. (macOS `chflags uchg` refuses the unlink
    // of this one file while the directory stays writable; skipped where that flag does not exist.)
    @Test
    fun anEmptiedNamespaceThatCannotBeUnlinkedKeepsTheLock() {
        enableLock()
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD) // no names index
        vault.relock()
        keys.invalidate()
        val blob = File(dir, "session-direct.bin")
        org.junit.Assume.assumeTrue(flags(blob, "uchg"))
        try {
            assertThrows(CoreError.Unavailable::class.java) { Vault(dir, keys).lockCipherForUnlock() }
        } finally {
            flags(blob, "nouchg")
        }
        assertTrue("the key stayed with its marker", keys.hasLockKey)
        val restarted = Vault(dir, keys)
        assertTrue(restarted.isLockWrapped())
        assertThrows(CoreError.Locked::class.java) { restarted.get("session-direct", "h1") }
        assertEquals("invalidated", assertThrows(CoreError::class.java) { restarted.lockCipherForUnlock() }.code)
        assertFalse(blob.exists())
        assertFalse(Vault(dir, keys).isLockWrapped())
    }

    // Round 11: the vault directory cannot be listed (its read permission is refused; files in it can
    // still be read and written). That is not "no namespaces": the wipe must fail before it deletes
    // the marker or key, a restart must still refuse the legacy secret (an older build's, with no
    // names index), and once the listing works again a retry completes. A never-created vault is empty.
    @Test
    fun aVaultThatCannotBeListedIsNotEmpty() {
        enableLock()
        vault.set("session-direct", "h1", "direct-token", Protection.STANDARD) // no names index
        vault.relock()
        keys.invalidate()
        assertTrue(dir.setReadable(false))
        try {
            assertThrows(CoreError.Unavailable::class.java) { Vault(dir, keys).lockCipherForUnlock() }
            assertTrue("the key stayed with its marker", keys.hasLockKey)
            val restarted = Vault(dir, keys)
            assertTrue(restarted.isLockWrapped())
            assertThrows(CoreError.Locked::class.java) { restarted.get("session-direct", "h1") }
        } finally {
            dir.setReadable(true)
        }
        assertEquals("invalidated", assertThrows(CoreError::class.java) { Vault(dir, keys).lockCipherForUnlock() }.code)
        assertFalse(Vault(dir, keys).isLockWrapped())
        assertEquals(emptyList<String>(), Vault(dir, keys).list("session-direct"))

        Vault(File(dir, "never-created"), keys).wipeLocked() // a fresh vault has nothing to list, and that is fine
    }

    @Test
    fun anEraseThatCannotListSaysSo() {
        vault.set("orgs", "list", "[]", Protection.STANDARD)
        assertTrue(dir.setReadable(false))
        try {
            assertThrows(CoreError.Unavailable::class.java) { Vault(dir, keys).eraseAll() }
        } finally {
            dir.setReadable(true)
        }
        Vault(dir, keys).eraseAll()
        assertEquals(emptyList<String>(), dir.list()!!.toList())
    }

    private fun flags(
        file: File,
        flag: String,
    ): Boolean = runCatching { ProcessBuilder("chflags", flag, file.path).start().waitFor() == 0 }.getOrDefault(false)

    private fun enableLock() {
        val cipher: Cipher = vault.lockCipherForEnable(allowDeviceCredential = false)
        vault.wrapUnderLock(cipher)
    }
}
