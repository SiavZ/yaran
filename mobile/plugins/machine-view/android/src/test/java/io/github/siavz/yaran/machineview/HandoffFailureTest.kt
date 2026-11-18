/**
 * HandoffFailureTest: storage and key store failures end a sign-in truthfully and never throw.
 *
 * Only a locked vault is `vault_locked`; a key store provider failure while the app is
 * unlocked, or a tampered record on the save after a successful browser sign-in, is
 * `secure_storage_failed`, the external-flow hold is released on every ending, and nothing
 * escapes to the io thread (where it would kill the app).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffFailureTest
 * ├── io.github.siavz.yaran.core.Vault
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Messages (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: java.net, java.security, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.core.CoreError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder
import java.security.ProviderException

class HandoffFailureTest {
    private val host = "laptop-ada.example.com"
    private val clock = 1_731_571_200L
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val orgs = OrgDirectory { if (it == "org1") "https://cp.example.com" else null }

    /** Counts the external-flow hold, so an ending that leaks it shows. */
    private class CountingLock : AppLockState by FakeLock() {
        var held = 0

        override fun holdForExternalFlow(ttlMs: Long) {
            held++
        }

        override fun releaseExternalFlow() {
            if (held > 0) held--
        }
    }

    private val lock = CountingLock()

    private fun client(backend: DeviceKeyBackend = SoftwareKeyBackend(), sessionVault: SecretVault = vault): HandoffClient {
        val installIds = InstallIdStore(vault)
        val keys = DeviceKeyStore(backend, installIds, diag)
        return HandoffClient(vault, orgs, SessionStore(sessionVault, diag) { }, keys, CallbackMode.Https("app.example.com"), "Pixel", { clock }, diag, lock)
    }

    @Test
    fun anUnlockedKeyStoreFailureIsNotALockedVault() {
        val broken = object : DeviceKeyBackend by SoftwareKeyBackend() {
            override fun exists(alias: String) = false

            override fun generate(alias: String): SecurityLevel = throw ProviderException("Keystore operation failed")
        }
        val out = client(broken).begin("org1", SignInTarget.Machine(host))
        assertEquals(Begin.Failed(SignInOutcome.SecureStorageFailed), out)
        assertEquals("no hold is left behind", 0, lock.held)
        assertTrue(diag.lines.any { it.contains("handoff start failed error=ProviderException") })
        assertEquals("try_again", Messages.signIn.getValue("secure_storage_failed").action)
    }

    @Test
    fun aLockedVaultIsStillVaultLocked() {
        val locked = object : SecretVault by vault {
            override fun write(ns: String, value: ByteArray, cls: ProtectionClass) = throw VaultLockedException()
        }
        val c = HandoffClient(locked, orgs, SessionStore(vault, diag) { }, DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag),
            CallbackMode.Https("app.example.com"), "Pixel", { clock }, diag, lock)
        assertEquals(Begin.Failed(SignInOutcome.VaultLocked), c.begin("org1", SignInTarget.Machine(host)))
        assertEquals(0, lock.held)
    }

    @Test
    fun aTamperedSaveAfterTheBrowserSignInEndsTruthfully() {
        val tampered = object : SecretVault by vault {
            override fun write(ns: String, value: ByteArray, cls: ProtectionClass) =
                if (ns.startsWith(SessionStore.PREFIX)) throw CoreError.Tampered("record failed its MAC") else vault.write(ns, value, cls)
        }
        val c = client(sessionVault = tampered)
        val q = query((c.begin("org1", SignInTarget.Machine(host)) as Begin.Launch).url)
        assertEquals(1, lock.held)
        val jwe = TestSealer.seal(q.getValue("pk"), host, q.getValue("state"), TestSealer.payload("machine", host, clock + 86_400, clock))
        val out = c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&jwe=$jwe")
        assertEquals(SignInOutcome.SecureStorageFailed, out)
        assertEquals("the hold is released after a failed save", 0, lock.held)
        assertTrue(diag.lines.any { it.contains("session save failed error=Tampered") })
    }

    @Test
    fun aMarkerThatCannotBeDeletedDoesNotFailTheEnding() {
        val stuck = object : SecretVault by vault {
            override fun delete(ns: String) = throw CoreError.Tampered("cannot delete")
        }
        val c = HandoffClient(stuck, orgs, SessionStore(vault, diag) { }, DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag),
            CallbackMode.Https("app.example.com"), "Pixel", { clock }, diag, lock)
        c.begin("org1", SignInTarget.Machine(host))
        assertEquals(SignInOutcome.Cancelled, c.onCancelled())
        assertEquals(0, lock.held)
        val q = query((c.begin("org1", SignInTarget.Machine(host)) as Begin.Launch).url)
        assertEquals(SignInOutcome.Declined, c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&error=handoff_declined"))
        assertEquals(0, lock.held)
    }

    // Round 7: sign-in A is replaced by B, then A's browser answers late. Whatever it carries
    // (A's state, garbage, an error), it neither ends B nor releases B's hold; B ends once.
    @Test
    fun aReplacedSignInsLateRedirectLeavesTheNewOneAlone() {
        val c = client()
        val a = query((c.begin("org1", SignInTarget.Machine(host)) as Begin.Launch).url)
        val b = query((c.begin("org1", SignInTarget.Machine(host)) as Begin.Launch).url)
        assertEquals("A gave its hold back; B holds", 1, lock.held)
        for (late in listOf("state=${a["state"]}&error=handoff_declined", "state=${"A".repeat(43)}&jwe=x.y", "error=handoff_declined")) {
            assertNull(late, c.onRedirect("https://app.example.com/auth/callback?$late"))
        }
        assertTrue(c.hasPending())
        assertEquals(1, lock.held)
        assertEquals(SignInOutcome.Declined, c.onRedirect("https://app.example.com/auth/callback?state=${b["state"]}&error=handoff_declined"))
        assertEquals(0, lock.held)
        assertNull("exactly once", c.onCancelled())
        assertEquals(0, lock.held)
    }

    @Test
    fun aHostWithADirectSessionIsNotSignedInThroughAnOrg() {
        vault.write("${DirectSessionStore.PREFIX}$host", "{}".toByteArray(), ProtectionClass.STANDARD)
        assertEquals(Begin.Failed(SignInOutcome.Refused("direct_host")), client().begin("org1", SignInTarget.Machine(host)))
    }

    // The collision check reads the vault too: an unreadable direct namespace must end the sign-in, not the io thread.
    @Test
    fun anUnreadableDirectNamespaceRefusesWithoutThrowingOrHolding() {
        val tampered = object : SecretVault by vault {
            override fun read(ns: String): ByteArray? =
                if (ns.startsWith(DirectSessionStore.PREFIX)) throw CoreError.Tampered("bad MAC") else vault.read(ns)
        }
        val c = HandoffClient(tampered, orgs, SessionStore(vault, diag) { }, DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag),
            CallbackMode.Https("app.example.com"), "Pixel", { clock }, diag, lock)
        assertEquals(Begin.Failed(SignInOutcome.Refused("direct_host")), c.begin("org1", SignInTarget.Machine(host)))
        assertEquals(0, lock.held)
        assertTrue("the control plane is not a machine host", c.begin("org1", SignInTarget.ControlPlane) is Begin.Launch)
    }

    // F7: the org lookup reads the vault too; its failure ends the sign-in truthfully, never the io thread.
    @Test
    fun aThrowingOrgLookupEndsTheSignInWithoutAHold() {
        val throwing = OrgDirectory { throw CoreError.Tampered("orgs/list failed its MAC") }
        val locked = OrgDirectory { throw VaultLockedException() }
        for ((dir, want) in listOf(throwing to SignInOutcome.SecureStorageFailed, locked to SignInOutcome.VaultLocked)) {
            val c = HandoffClient(vault, dir, SessionStore(vault, diag) { }, DeviceKeyStore(SoftwareKeyBackend(), InstallIdStore(vault), diag),
                CallbackMode.Https("app.example.com"), "Pixel", { clock }, diag, lock)
            assertEquals(Begin.Failed(want), c.begin("org1", SignInTarget.ControlPlane))
            assertEquals(0, lock.held)
            assertEquals("with nothing pending, a late cancel or error is no outcome", null, c.onCancelled())
        }
    }

    private fun query(url: String) = url.substringAfter('?').split('&').associate {
        it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }
}
