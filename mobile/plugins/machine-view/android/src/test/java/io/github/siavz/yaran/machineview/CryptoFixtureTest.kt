/**
 * Fixture pins for the sealed-envelope opener and the device signature (02 §8, §8.1).
 *
 * Every valid 02 JWE vector opens to its payload, every invalid one fails with the code it
 * names, the Concat KDF reproduces RFC 7518 Appendix C and RFC 7520 §5.5, the canonical
 * string and committed signature verify with the fixture key, DER converts to raw exactly,
 * and every device fingerprint matches.
 *
 * - Pure JVM (JCA).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.CryptoFixtureTest
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.Fixtures
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * └── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * External: java.security, java.security.spec, org.json, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit and Robolectric, via ./gradlew testDebugUnitTest in mobile/plugins/machine-view/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.machineview.Fixtures.hex
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class CryptoFixtureTest {
    private fun jweFiles() = Fixtures.protocolDir("fixtures/jwe").listFiles()!!.filter { it.name.startsWith("handoff-v1-") }.sortedBy { it.name }

    private fun open(v: JSONObject): OpenResult {
        val r = SealedEnvelope.recipientFromScalar(B64url.decode(v.getJSONObject("recipient_jwk").getString("d"))!!, v.getString("recipient_pk"))
        return SealedEnvelope.open(v.getString("compact_jwe"), r, v.getString("expected_host"), v.getString("expected_state"), v.getString("expected_kind"), v.getLong("now"))
    }

    @Test
    fun validVectorsOpen() {
        val valid = jweFiles().filter { it.name.contains("-valid-") }
        assertEquals(2, valid.size)
        for (f in valid) {
            val v = JSONObject(f.readText())
            val got = open(v)
            assertTrue(f.name, got is OpenResult.Opened)
            val p = (got as OpenResult.Opened).payload
            val e = v.getJSONObject("plaintext")
            assertEquals(f.name, HandoffPayload(e.getString("kind"), e.getString("host"), e.getString("jwt"), e.getString("email"),
                e.getLong("exp"), e.getLong("iat"), if (e.has("cookie")) e.getString("cookie") else null), p)
            assertFalse(p.toString().contains(p.jwt))
        }
    }

    @Test
    fun invalidVectorsFailClosedWithTheirCode() {
        val invalid = jweFiles().filter { it.name.contains("-invalid-") }
        assertEquals(15, invalid.size)
        for (f in invalid) {
            val v = JSONObject(f.readText())
            assertEquals(f.name, OpenResult.Failed(v.getString("expect_code")), open(v))
        }
    }

    @Test
    fun aFreshRecipientRoundTripsItsPoint() {
        val r = SealedEnvelope.generateRecipient()
        assertEquals(87, r.pk.length)
        assertTrue(P256.decodePoint(r.pk) != null)
        assertFalse(r.toString().contains("privateKey"))
    }

    @Test
    fun concatKdfMatchesTheRfcs() {
        val c = Fixtures.protocol("fixtures/jwe/kdf-rfc7518-appendix-c.json")
        assertArrayEquals(hex(c.getString("k_hex")), SealedEnvelope.concatKdf(hex(c.getString("z_hex")), c.getString("enc"),
            c.getString("apu_utf8").toByteArray(), c.getString("apv_utf8").toByteArray(), c.getInt("keydatalen")))
        val d = Fixtures.protocol("fixtures/jwe/kdf-rfc7520-5.5.json")
        assertArrayEquals(hex(d.getString("cek_hex")), SealedEnvelope.concatKdf(hex(d.getString("z_hex")), d.getString("enc"),
            d.getString("apu_utf8").toByteArray(), d.getString("apv_utf8").toByteArray(), d.getInt("keydatalen")))
    }

    @Test
    fun deviceSignatureCanonicalAndVerify() {
        val f = Fixtures.protocol("fixtures/sig/handoff-device-signature.json")
        val canonical = HandoffSignature.canonical(f.getString("host"), f.getString("pk"), f.getString("state"), f.getString("dts").toLong())
        assertEquals(f.getString("canonical_utf8"), canonical)
        assertArrayEquals(hex(f.getString("canonical_hex")), canonical.toByteArray())
        var verified = 0
        for (c in Fixtures.cases(f)) {
            val e = c.getJSONObject("expect")
            if (!e.has("verified")) continue
            val fl = c.getJSONObject("fields")
            val point = P256.decodePoint(fl.getString("dk"))!!
            val sig = Signature.getInstance("SHA256withECDSA").apply {
                initVerify(P256.publicKey(point))
                update(HandoffSignature.canonical(fl.getString("host"), fl.getString("pk"), fl.getString("state"), fl.getString("dts").toLong()).toByteArray())
            }
            assertEquals(c.getString("name"), e.getBoolean("verified"), sig.verify(HandoffSignature.rawToDer(B64url.decode(fl.getString("dsig"))!!)))
            verified++
        }
        assertTrue(verified >= 9)
    }

    @Test
    fun derToRaw() {
        for (c in Fixtures.cases(Fixtures.plugin("der-signatures.json"))) {
            val got = HandoffSignature.derToRawB64(hex(c.getString("der_hex")))
            if (c.optBoolean("error")) assertNull(c.getString("name"), got) else {
                assertEquals(c.getString("name"), c.getString("raw_b64url"), got)
                assertArrayEquals(c.getString("name"), hex(c.getString("der_hex")), HandoffSignature.rawToDer(B64url.decode(got!!)!!))
            }
        }
    }

    @Test
    fun aSignatureMadeHereVerifiesAfterConversion() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        repeat(20) {
            val data = "yaran-handoff-device-v1\nh\n$it\n".toByteArray()
            val der = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(data) }.sign()
            val raw = HandoffSignature.derToRaw(der)!!
            val ok = Signature.getInstance("SHA256withECDSA").apply { initVerify(kp.public); update(data) }.verify(HandoffSignature.rawToDer(raw))
            assertTrue(ok)
        }
    }

    @Test
    fun deviceFingerprints() {
        val f = Fixtures.protocol("fixtures/sig/device-fingerprint.json")
        for (c in Fixtures.cases(f)) {
            val point = P256.decodePoint(c.getString("dk"))!!
            assertArrayEquals(hex(c.getString("dk_hex")), point)
            val fp24 = HandoffSignature.fingerprint24(point)
            assertEquals(c.getString("fp24"), fp24)
            assertEquals(c.getString("fingerprint"), HandoffSignature.displayFingerprint(fp24))
        }
    }
}
