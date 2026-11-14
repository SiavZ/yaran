/**
 * The handoff orchestrator end to end against a sealing fake server (work items 4 and 5).
 *
 * Success on both callback forms (and query and fragment), remembered consent (a straight
 * redirect), cancel, declined, clock skew, a device key refusal with its level, state
 * mismatch, the wrong form for the build, TTL expiry, replay, process death ("interrupted"
 * with only a key-free marker ever in the vault) and the D24 device signature on the URL.
 *
 * - Pure JVM with fakes.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffClientTest
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * └── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * External: java.net, java.security, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URLDecoder
import java.security.Signature

class HandoffClientTest {
    private val host = "laptop-ada.example.com"
    private var clock = 1_731_571_200L
    private val vault = FakeVault()
    private val diag = FakeDiagnostics()
    private val backend = SoftwareKeyBackend()
    private val installIds = InstallIdStore(vault)
    private val keys = DeviceKeyStore(backend, installIds, diag)
    private val sessions = SessionStore(vault, FakeLock(), diag) { }
    private val orgs = OrgDirectory { if (it == "org1") "https://cp.example.com" else null }

    private fun client(mode: CallbackMode = CallbackMode.Https("app.example.com")) =
        HandoffClient(vault, orgs, sessions, keys, mode, "Ada's Pixel", { clock }, diag)

    private fun query(url: String) = url.substringAfter('?').split('&').associate {
        it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
    }

    private fun begin(c: HandoffClient, target: SignInTarget = SignInTarget.Machine(host)) =
        query((c.begin("org1", target) as Begin.Launch).url)

    private fun sealed(q: Map<String, String>, h: String = host, kind: String = "machine", exp: Long = clock + 86_400) =
        TestSealer.seal(q.getValue("pk"), h, q.getValue("state"), TestSealer.payload(kind, h, exp, clock))

    @Test
    fun releaseSuccessStoresTheSessionAndSignsTheRequest() {
        val c = client()
        val q = begin(c)
        assertEquals("https://app.example.com/auth/callback", q["redirect"])
        assertEquals("Ada's Pixel", q["device"])
        assertNull(q["build"])
        val dk = P256.decodePoint(q.getValue("dk"))!!
        val ok = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(P256.publicKey(dk))
            update(HandoffSignature.canonical(host, q.getValue("pk"), q.getValue("state"), q.getValue("dts").toLong()).toByteArray())
        }.verify(HandoffSignature.rawToDer(B64url.decode(q.getValue("dsig"))!!))
        assertTrue(ok)
        val out = c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&jwe=${sealed(q)}")
        assertEquals(SignInOutcome.SignedIn(host, "ada@example.org", clock + 86_400), out)
        assertEquals("org1", sessions.get(host)!!.orgId)
        assertNull(vault.data[HandoffClient.MARKER_NS])
    }

    @Test
    fun devFragmentSuccessAndControlPlaneKind() {
        val c = client(CallbackMode.Dev)
        val q = begin(c, SignInTarget.ControlPlane)
        assertEquals("dev", q["build"])
        assertEquals("yaranapp://auth/callback", q["redirect"])
        val jwe = sealed(q, h = "cp.example.com", kind = "control_plane")
        val out = c.onRedirect("yaranapp://auth/callback#state=${q["state"]}&jwe=$jwe")
        assertTrue(out is SignInOutcome.SignedIn)
        assertTrue(sessions.get("cp.example.com") != null)
    }

    @Test
    fun replayIsRefused() {
        val c = client()
        val q = begin(c)
        val uri = "https://app.example.com/auth/callback?state=${q["state"]}&jwe=${sealed(q)}"
        assertTrue(c.onRedirect(uri) is SignInOutcome.SignedIn)
        assertEquals(SignInOutcome.Mismatch, c.onRedirect(uri))
    }

    @Test
    fun wrongFormForTheBuildIsRefused() {
        val c = client()
        val q = begin(c)
        assertEquals(SignInOutcome.Mismatch, c.onRedirect("yaranapp://auth/callback?state=${q["state"]}&jwe=${sealed(q)}"))
        assertNull(sessions.get(host))
    }

    @Test
    fun stateMismatchAndTtl() {
        val c = client()
        val q = begin(c)
        assertEquals(SignInOutcome.Mismatch, c.onRedirect("https://app.example.com/auth/callback?state=${"A".repeat(43)}&jwe=${sealed(q)}"))
        val q2 = begin(c)
        clock += 601
        assertEquals(SignInOutcome.Mismatch, c.onRedirect("https://app.example.com/auth/callback?state=${q2["state"]}&jwe=${sealed(q2)}"))
    }

    @Test
    fun callbackErrorsMapToOutcomes() {
        val c = client()
        fun err(code: String, extra: String = ""): SignInOutcome {
            val q = begin(c)
            return c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&error=$code$extra")
        }
        assertEquals(SignInOutcome.Declined, err("handoff_declined"))
        assertEquals(SignInOutcome.RateLimited, err("rate_limited"))
        assertEquals(SignInOutcome.ClockSkewed(1_731_571_900), err("handoff_timestamp_skewed", "&server_time=1731571900"))
        assertEquals(SignInOutcome.ProtocolUnsupported(2, 3), err("protocol_unsupported", "&min=2&max=3"))
        assertEquals(SignInOutcome.DeviceKeyRejected("handoff_signature_malformed", SecurityLevel.TEE), err("handoff_signature_malformed"))
        assertEquals(SignInOutcome.NotOwner(null), err("handoff_owner_mismatch"))
        assertEquals(SignInOutcome.Refused("handoff_request_invalid"), err("handoff_request_invalid"))
        assertTrue(diag.lines.any { it.contains("level=tee") })
    }

    @Test
    fun envelopeFailures() {
        val c = client()
        val q = begin(c)
        val expired = sealed(q, exp = clock + 30)
        assertEquals(SignInOutcome.EnvelopeExpired, c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&jwe=$expired"))
        val q2 = begin(c)
        val otherKind = sealed(q2, kind = "control_plane")
        assertEquals(SignInOutcome.DecryptFailed("jwe_kind_mismatch"), c.onRedirect("https://app.example.com/auth/callback?state=${q2["state"]}&jwe=$otherKind"))
    }

    @Test
    fun cancelVerificationAndNoBrowser() {
        val c = client()
        begin(c)
        assertEquals(SignInOutcome.Cancelled, c.onCancelled())
        assertNull(c.onCancelled())
        begin(c)
        assertEquals(SignInOutcome.VerificationFailed("app.example.com"), c.onVerificationFailed())
        begin(c)
        assertEquals(SignInOutcome.NoBrowser, c.onNoBrowser())
        assertNull(vault.data[HandoffClient.MARKER_NS])
    }

    @Test
    fun processDeathEndsInterruptedAndNoKeyWasEverStored() {
        val first = client()
        val q = begin(first)
        val jwe = sealed(q)
        // A new process: same vault, no in-memory pending entry.
        val second = client()
        assertEquals(SignInOutcome.Interrupted, second.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&jwe=$jwe"))
        assertNull(sessions.get(host))
        val markerWrites = vault.writes.filter { it.first == HandoffClient.MARKER_NS }
        assertEquals(1, markerWrites.size)
        val marker = org.json.JSONObject(markerWrites.single().second)
        assertEquals(setOf("state", "host", "target", "created_at"), marker.keys().asSequence().toSet())
        assertFalse(vault.writes.any { it.second.contains(q.getValue("pk")) })
    }

    @Test
    fun unknownOrgAndBadHost() {
        val c = client()
        assertEquals(Begin.Failed(SignInOutcome.Refused("unknown_org")), c.begin("nope", SignInTarget.ControlPlane))
        assertEquals(Begin.Failed(SignInOutcome.Refused("host_invalid")), c.begin("org1", SignInTarget.Machine("Bad_Host")))
    }

    @Test
    fun diagnosticsNeverCarryTokensOrQueries() {
        val c = client()
        val q = begin(c)
        c.onRedirect("https://app.example.com/auth/callback?state=${q["state"]}&jwe=${sealed(q)}")
        begin(c)
        c.onRedirect("https://app.example.com/auth/callback?state=bad&jwe=x")
        for (line in diag.lines) {
            assertFalse(line, line.contains("eyJ") || line.contains("?") || line.contains("jwe=") || line.contains(q.getValue("state")))
        }
    }
}
