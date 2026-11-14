/**
 * Tests for CoreAdapters: this plugin's vault names over Phase 14's real core Vault.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CoreAdaptersTest
 * ├── io.github.siavz.yaran.core.KeyProvider
 * ├── io.github.siavz.yaran.core.Vault
 * ├── io.github.siavz.yaran.machineview.CoreAdapters (inferred)
 * └── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * External: javax.crypto, org.junit, org.junit.Assert, org.junit.rules
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.core.CoreError
import io.github.siavz.yaran.core.KeyProvider
import io.github.siavz.yaran.core.Vault
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class CoreAdaptersTest {
    @get:Rule val tmp = TemporaryFolder()

    private class SoftwareKeys : KeyProvider {
        private val standard: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        override fun standardKey() = standard

        override fun createLockKey(allowDeviceCredential: Boolean) = Unit

        override fun lockCipher(mode: Int, iv: ByteArray?): Cipher = throw CoreError.Unavailable("no lock key in this test")

        override fun deleteLockKey() = Unit

        override fun deleteAll() = Unit
    }

    private fun vault() = Vault(tmp.newFolder(), SoftwareKeys())

    @Test
    fun namesLongerThanAVaultKeyRoundTripAndList() {
        val core = vault()
        val secrets = VaultSecrets(core)
        val long = "a".repeat(60) + ".machines.example.com"
        val org = "https://cp.example.com"
        secrets.write("session/$long", "{\"jwt\":\"x\"}".toByteArray(), ProtectionClass.LOCKED)
        secrets.write("session/m1.example.com", "{}".toByteArray(), ProtectionClass.STANDARD)
        secrets.write("install/$org", "{\"install_id\":\"i\"}".toByteArray(), ProtectionClass.STANDARD)
        secrets.write("handoff", "{\"state\":\"s\"}".toByteArray(), ProtectionClass.STANDARD)

        assertArrayEquals("{\"jwt\":\"x\"}".toByteArray(), secrets.read("session/$long"))
        assertEquals(listOf("session/$long", "session/m1.example.com"), secrets.list("session/"))
        assertEquals(listOf("install/$org"), secrets.list("install/"))
        assertEquals("{\"state\":\"s\"}", String(secrets.read("handoff")!!))

        secrets.delete("session/$long")
        assertNull(secrets.read("session/$long"))
        assertEquals(listOf("session/m1.example.com"), secrets.list("session/"))
        secrets.delete("session/m1.example.com")
        assertEquals(emptyList<String>(), secrets.list("session/"))
        // The index key goes with the last name, so the namespace file is gone too.
        assertEquals(emptyList<String>(), core.list("session"))
    }

    @Test
    fun orgDirectoryReadsOnlyOnboardedOrgs() {
        val core = vault()
        val orgs = OrgList(core)
        assertNull(orgs.orgUrl("https://cp.example.com"))
        core.set("orgs", "list", """[{"id":"https://cp.example.com","name":"Ada","teamDomain":null,"addedAt":"x"}]""", io.github.siavz.yaran.core.Protection.STANDARD)
        assertEquals("https://cp.example.com", orgs.orgUrl("https://cp.example.com"))
        assertNull(orgs.orgUrl("https://evil.example.com"))
        core.set("orgs", "list", "not json", io.github.siavz.yaran.core.Protection.STANDARD)
        assertNull(orgs.orgUrl("https://cp.example.com"))
    }
}
