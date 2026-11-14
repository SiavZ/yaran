/**
 * Session store, install id and device key store (work item 6, D24).
 *
 * Two orgs get different keys; the install id and key are minted and deleted together; a
 * missing half remints both; minting writes one diagnostics line with level and fingerprint
 * but no key; sessions take the earlier exp, go to the locked class under app lock, and
 * sign-out clears every host it is given plus the org's others.
 *
 * - Pure JVM with fakes.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.StoresTest
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit and Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/machine-view/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StoresTest {
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val backend = SoftwareKeyBackend(SecurityLevel.STRONGBOX)
    private val installIds = InstallIdStore(vault)
    private val keys = DeviceKeyStore(backend, installIds, diag)
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    @Test
    fun twoOrgsGetDifferentKeysAndInstallIds() {
        val a = keys.ensure("a")
        val b = keys.ensure("b")
        assertNotEquals(a.publicKey, b.publicKey)
        assertNotEquals(a.installId, b.installId)
        assertTrue(uuid.matches(a.installId))
        assertEquals(a, keys.ensure("a"))
        assertTrue(P256.decodePoint(a.publicKey) != null)
    }

    @Test
    fun mintingLogsLevelAndFingerprintButNoKey() {
        val id = keys.ensure("a")
        val line = diag.lines.single()
        val fp = HandoffSignature.displayFingerprint(HandoffSignature.fingerprint24(P256.decodePoint(id.publicKey)!!))
        assertEquals("machine-view device key minted level=strongbox fp=$fp", line)
        assertFalse(line.contains(id.publicKey))
    }

    @Test
    fun aMissingHalfRemintsBoth() {
        val first = keys.ensure("a")
        backend.delete(keys.alias("a"))
        val second = keys.ensure("a")
        assertNotEquals(first.installId, second.installId)
        installIds.delete("a")
        val third = keys.ensure("a")
        assertNotEquals(second.publicKey, third.publicKey)
        assertTrue(diag.lines.count { it.contains("reminted") } == 2)
    }

    @Test
    fun deleteRemovesBoth() {
        keys.ensure("a")
        keys.delete("a")
        assertNull(installIds.get("a"))
        assertFalse(backend.exists(keys.alias("a")))
        assertNull(keys.publicKey("a"))
    }

    @Test
    fun signatureVerifies() {
        val id = keys.ensure("a")
        val sig = keys.sign("a", "hello")
        val ok = java.security.Signature.getInstance("SHA256withECDSA").apply {
            initVerify(P256.publicKey(P256.decodePoint(id.publicKey)!!)); update("hello".toByteArray())
        }.verify(HandoffSignature.rawToDer(B64url.decode(sig)!!))
        assertTrue(ok)
        assertEquals(86, sig.length)
    }

    @Test
    fun registeredFlag() {
        keys.ensure("a")
        assertFalse(installIds.get("a")!!.registered)
        installIds.markRegistered("a")
        assertTrue(installIds.get("a")!!.registered)
        assertEquals(ProtectionClass.STANDARD, vault.classes["install/a"])
    }

    @Test
    fun sessionsTakeTheEarlierExpAndFollowTheLock() {
        val cleared = mutableListOf<String>()
        val lock = FakeLock(enabled = true)
        val s = SessionStore(vault, lock, diag) { cleared += it }
        val p = TestSealer.payload("machine", "m1.example.com", 2_000, 1_000, jwtExp = 1_500)
        s.put("org1", payload(p))
        assertEquals(1_500, s.get("m1.example.com")!!.exp)
        assertEquals(ProtectionClass.LOCKED, vault.classes["session/m1.example.com"])
        assertNull(s.status("m1.example.com", 1_500))
        assertTrue(s.status("m1.example.com", 1_499) != null)
        assertFalse(s.get("m1.example.com").toString().contains("eyJ"))
        vault.locked = true
        try {
            s.get("m1.example.com")
            error("expected the locked vault to refuse")
        } catch (e: VaultLockedException) {
            // expected
        }
    }

    @Test
    fun signOutClearsGivenHostsAndTheOrgsOthers() {
        val cleared = mutableListOf<String>()
        val s = SessionStore(vault, FakeLock(), diag) { cleared += it }
        s.put("org1", payload(TestSealer.payload("machine", "m1.example.com", 2_000, 1_000)))
        s.put("org1", payload(TestSealer.payload("machine", "m2.example.com", 2_000, 1_000)))
        s.put("org2", payload(TestSealer.payload("machine", "m3.example.com", 2_000, 1_000)))
        assertEquals(listOf("m1.example.com", "m2.example.com"), s.hostsFor("org1"))
        s.signOut("org1", listOf("m1.example.com"))
        assertEquals(setOf("m1.example.com", "m2.example.com"), cleared.toSet())
        assertNull(s.get("m2.example.com"))
        assertTrue(s.get("m3.example.com") != null)
    }

    @Test
    fun unreadableJwtExpFallsBackWithADiagnostic() {
        val s = SessionStore(vault, FakeLock(), diag) { }
        val p = TestSealer.payload("machine", "m1.example.com", 2_000, 1_000).put("jwt", "a.b.c")
        s.put("org1", payload(p))
        assertEquals(2_000, s.get("m1.example.com")!!.exp)
        assertTrue(diag.lines.any { it.contains("jwt exp unreadable") })
    }

    private fun payload(o: org.json.JSONObject) = HandoffPayload(o.getString("kind"), o.getString("host"), o.getString("jwt"),
        o.getString("email"), o.getLong("exp"), o.getLong("iat"), null)
}
