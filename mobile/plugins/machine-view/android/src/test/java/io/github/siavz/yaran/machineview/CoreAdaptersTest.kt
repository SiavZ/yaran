/**
 * Tests for CoreAdapters: this plugin's vault names over Phase 14's real core Vault.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CoreAdaptersTest
 * ├── io.github.siavz.yaran.core.KeyProvider
 * ├── io.github.siavz.yaran.core.Vault
 * ├── io.github.siavz.yaran.machineview.CoreAdapters (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: java.io, javax.crypto, javax.crypto.spec, org.json, org.junit, org.junit.Assert, org.junit.rules
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
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import javax.crypto.Cipher
import org.json.JSONObject
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class CoreAdaptersTest {
    @get:Rule val tmp = TemporaryFolder()

    private class SoftwareKeys : KeyProvider {
        private val standard: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

        /** Key uses left before the store fails like a broken keystore would; null is unlimited. */
        var budget: Int? = null

        override fun standardKey(): SecretKey {
            budget = budget?.let { if (it == 0) throw CoreError.Unavailable("keystore failed") else it - 1 }
            return standard
        }

        private var lock: SecretKey? = null

        override fun createLockKey(allowDeviceCredential: Boolean) {
            lock = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        }

        override fun lockCipher(mode: Int, iv: ByteArray?): Cipher {
            val key = lock ?: throw CoreError.Unavailable("no lock key")
            return Cipher.getInstance("AES/GCM/NoPadding").apply { if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv)) }
        }

        override fun deleteLockKey() {
            lock = null
        }

        override fun deleteAll() = Unit
    }

    private fun vault() = Vault(tmp.newFolder(), SoftwareKeys())

    // Over the real core Vault: a direct token is never readable once App Lock is on, whether it
    // was written after this fix (locked class from creation) or by an older build (standard).
    @Test
    fun directSessionsAreUnreadableOnceTheLockIsEnabled() {
        val dir = tmp.newFolder()
        val keys = SoftwareKeys()
        val core = Vault(dir, keys)
        val secrets = VaultSecrets(core)
        DirectSessionStore(secrets).put(DirectSession("a.example.com", "tokA", "yaran_session_443", "i1", 1))
        val legacy = JSONObject().put("host", "b.example.com").put("token", "tokB").put("cookie_name", "yaran_session_443")
            .put("instance", "i1").put("issued_at", 1)
        secrets.write("session-direct/b.example.com", legacy.toString().toByteArray(), ProtectionClass.STANDARD)
        assertEquals("tokB", DirectSessionStore(secrets).get("b.example.com")!!.token)

        core.wrapUnderLock(core.lockCipherForEnable(allowDeviceCredential = false))
        val relaunched = DirectSessionStore(VaultSecrets(Vault(dir, keys)))
        for (host in listOf("a.example.com", "b.example.com")) {
            try {
                relaunched.get(host)
                error("$host was readable behind the lock")
            } catch (e: VaultLockedException) {
                // expected
            }
        }
        assertEquals("the host list still reads while locked", listOf("a.example.com", "b.example.com"), relaunched.hosts())
    }

    // Round 4: a replacement that fails part-way never leaves the new (revoked) token where the
    // kept one was. Two key uses in, the store breaks: before the fix that was after the record
    // was replaced and before the index was rewritten.
    @Test
    fun aReplacementThatFailsPartWayKeepsTheOldSession() {
        val keys = SoftwareKeys()
        val store = DirectSessionStore(VaultSecrets(Vault(tmp.newFolder(), keys)))
        store.put(DirectSession("a.example.com", "tokA", "yaran_session_443", "i1", 1, "idA_aaaaaaaaaaaaaaaaaa"))
        keys.budget = 2
        try {
            store.put(DirectSession("a.example.com", "tokB", "yaran_session_443", "i1", 2, "idB_bbbbbbbbbbbbbbbbbb"))
            error("the broken store accepted the write")
        } catch (e: Exception) {
            // expected: keep() revokes tokB and reports secure_storage_failed
        }
        keys.budget = null
        assertEquals("tokA", store.get("a.example.com")!!.token)
        assertEquals(listOf("a.example.com"), store.hosts())
    }

    // Round 12: org sign-out with the session namespace unreadable (real vault, read permission
    // refused on its file), then with one record unreadable. Neither is "no sessions": the wipe
    // throws with nothing deleted, no host cleared and the device identity kept, and a retry
    // once the store reads again finishes it.
    @Test
    fun anOrgWipeThatCannotFindEverySessionDeletesNothing() {
        val dir = tmp.newFolder()
        val secrets = VaultSecrets(Vault(dir, SoftwareKeys()))
        val org = "https://cp.example.com"
        val record = JSONObject().put("org_id", org).put("jwt", "e30.e30.c2ln").put("exp", 9_999_999_999L).put("iat", 1L).put("email", "ada@example.org")
        secrets.write("session/a.example.com", record.toString().toByteArray(), ProtectionClass.LOCKED)
        val cleared = mutableListOf<String>()
        val sessions = SessionStore(secrets, FakeDiagnostics(), WebDataCleaner { cleared += it })
        val ids = InstallIdStore(secrets)
        val keys = DeviceKeyStore(SoftwareKeyBackend(), ids, FakeDiagnostics())
        val identity = keys.ensure(org).installId
        val blob = File(dir, "session.bin")
        assertTrue(blob.setReadable(false))
        try {
            assertThrows(Exception::class.java) { wipeOrgData(sessions, keys, org, emptyList()) }
        } finally {
            blob.setReadable(true)
        }
        assertEquals("the session stays", org, sessions.get("a.example.com")!!.orgId)
        assertEquals("the identity stays for a retry", identity, ids.get(org)!!.installId)
        assertEquals(emptyList<String>(), cleared)

        // One record unreadable while the listing works: that record may be this org's.
        val broken = object : SecretVault by secrets {
            override fun read(ns: String): ByteArray? = if (ns == "session/b.example.com") throw CoreError.Unavailable("read failed") else secrets.read(ns)
        }
        secrets.write("session/b.example.com", record.toString().toByteArray(), ProtectionClass.LOCKED)
        val partial = SessionStore(broken, FakeDiagnostics(), WebDataCleaner { cleared += it })
        assertThrows(Exception::class.java) { wipeOrgData(partial, keys, org, emptyList()) }
        assertEquals(org, sessions.get("a.example.com")!!.orgId)
        assertEquals(identity, ids.get(org)!!.installId)
        assertEquals(emptyList<String>(), cleared)

        wipeOrgData(sessions, keys, org, emptyList())
        assertNull(sessions.get("a.example.com"))
        assertNull(sessions.get("b.example.com"))
        assertNull(ids.get(org))
        assertEquals(listOf("a.example.com", "b.example.com"), cleared.sorted())
    }

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
