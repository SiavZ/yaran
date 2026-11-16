/**
 * Opens the sealed handoff envelope: profile `yaran-handoff+jwe` v1 (02 §8).
 *
 * ECDH-ES with the Concat KDF (SHA-256) and A256GCM over the transmitted protected header,
 * sealed by the server to the ephemeral P-256 key this phone generated for one handoff.
 * Enforces opener obligations 1-7 in 02's order with 02's `jwe_*` codes, including the
 * explicit on-curve check of `epk`; obligation 8 (the private key lives in memory only) is
 * kept by [generateRecipient] returning a JCA key that is never serialized. Pinned by every
 * vector in `cloud/protocol/fixtures/jwe/`.
 *
 * - Pure JCA. Failures carry a code only; no secret ever reaches a message or `toString()`.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SealedEnvelope
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.math, java.security, java.security.interfaces, java.security.spec, javax.crypto, javax.crypto.spec, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.SealedEnvelope
 * ├── io.github.siavz.yaran.machineview.CryptoFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONException
import org.json.JSONObject
import java.math.BigInteger
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal data class HandoffPayload(
    val kind: String,
    val host: String,
    val jwt: String,
    val email: String,
    val exp: Long,
    val iat: Long,
    val cookie: String?,
) {
    override fun toString() = "HandoffPayload(kind=$kind, host=$host, exp=$exp, iat=$iat)"
}

internal sealed interface OpenResult {
    data class Opened(val payload: HandoffPayload) : OpenResult
    data class Failed(val code: String) : OpenResult
}

/** One handoff's ephemeral recipient key; `pk` is the 87-character query value. */
internal class Recipient(val privateKey: PrivateKey, val pk: String) {
    override fun toString() = "Recipient(pk=$pk)"
}

internal object SealedEnvelope {
    const val KIND_MACHINE = "machine"
    const val KIND_CONTROL_PLANE = "control_plane"
    private const val MIN_REMAINING_S = 60L
    private val HOSTNAME = HostRules.HOSTNAME
    private val JWT = Regex("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$")
    private val KEYS = setOf("v", "kind", "host", "jwt", "email", "exp", "iat", "cookie")

    fun generateRecipient(): Recipient {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        return Recipient(kp.private, B64url.encode(P256.encodePoint(kp.public as ECPublicKey)))
    }

    /** Test vectors and nothing else import a recipient private scalar. */
    fun recipientFromScalar(d: ByteArray, pk: String): Recipient =
        Recipient(KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, d), P256.params)), pk)

    fun concatKdf(z: ByteArray, algorithmId: String, apu: ByteArray, apv: ByteArray, keyBits: Int): ByteArray {
        fun be32(n: Int) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
        fun lp(b: ByteArray) = be32(b.size) + b
        val otherInfo = lp(algorithmId.toByteArray(Charsets.US_ASCII)) + lp(apu) + lp(apv) + be32(keyBits)
        val out = java.io.ByteArrayOutputStream()
        var counter = 1
        while (out.size() < keyBits / 8) {
            out.write(MessageDigest.getInstance("SHA-256").digest(be32(counter++) + z + otherInfo))
        }
        return out.toByteArray().copyOf(keyBits / 8)
    }

    fun open(jwe: String, recipient: Recipient, expectedHost: String, expectedState: String, expectedKind: String, now: Long): OpenResult {
        fun fail(code: String) = OpenResult.Failed(code)
        // 1. Five parts, empty encrypted key, JSON header, 12-byte IV, 16-byte tag.
        val parts = jwe.split('.')
        if (parts.size != 5 || parts[1].isNotEmpty()) return fail("jwe_malformed")
        val headerB64 = parts[0]
        val header = B64url.decode(headerB64)?.let { jsonObject(it) }
        val iv = B64url.decode(parts[2])
        val ct = B64url.decode(parts[3])
        val tag = B64url.decode(parts[4])
        if (header == null || iv == null || ct == null || tag == null || iv.size != 12 || tag.size != 16) return fail("jwe_malformed")
        // 2. Profile parameters.
        if (header.optString("alg") != "ECDH-ES" || header.optString("enc") != "A256GCM" ||
            header.optString("typ") != "yaran-handoff+jwe" || header.optString("cty") != "yaran-handoff+json"
        ) return fail("jwe_unsupported")
        // 3. kid is the thumbprint of this handoff's key.
        val own = P256.decodePoint(recipient.pk) ?: throw IllegalArgumentException("recipient pk is not a P-256 point")
        if (header.opt("kid") != P256.thumbprint(own)) return fail("jwe_kid_mismatch")
        // 4. epk is a valid P-256 point.
        val epk = header.opt("epk") as? JSONObject ?: return fail("jwe_point_invalid")
        if (epk.opt("kty") != "EC" || epk.opt("crv") != "P-256") return fail("jwe_point_invalid")
        val x = (epk.opt("x") as? String)?.let { B64url.decode(it) }
        val y = (epk.opt("y") as? String)?.let { B64url.decode(it) }
        if (x == null || y == null || !P256.isOnCurve(x, y)) return fail("jwe_point_invalid")
        // 5. apv is the stored state (constant time), apu the opened host.
        val apv = (header.opt("apv") as? String)?.let { B64url.decode(it) }
        if (apv == null || !MessageDigest.isEqual(apv, expectedState.toByteArray(Charsets.UTF_8))) return fail("jwe_state_mismatch")
        val apu = (header.opt("apu") as? String)?.let { B64url.decode(it) }
        if (apu == null || String(apu, Charsets.UTF_8) != expectedHost) return fail("jwe_host_mismatch")
        // 6. ECDH, Concat KDF, AES-256-GCM with the transmitted header as AAD.
        val plaintext = try {
            val z = KeyAgreement.getInstance("ECDH").run {
                init(recipient.privateKey)
                doPhase(P256.publicKey(byteArrayOf(4) + x + y), true)
                generateSecret()
            }
            val cek = concatKdf(z, "A256GCM", apu, apv, 256)
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, iv))
                updateAAD(headerB64.toByteArray(Charsets.US_ASCII))
                doFinal(ct + tag)
            }
        } catch (e: GeneralSecurityException) {
            return fail("jwe_decrypt_failed")
        }
        // 7. Plaintext host, kind and expiry.
        val payload = payload(plaintext) ?: return fail("jwe_malformed")
        if (payload.host != expectedHost) return fail("jwe_host_mismatch")
        if (payload.kind != expectedKind) return fail("jwe_kind_mismatch")
        if (payload.exp <= now + MIN_REMAINING_S) return fail("jwe_expired")
        return OpenResult.Opened(payload)
    }

    private fun jsonObject(bytes: ByteArray): JSONObject? {
        val text = strictUtf8(bytes) ?: return null
        return try {
            if (text.trimStart().startsWith("{")) JSONObject(text) else null
        } catch (e: JSONException) {
            null
        }
    }

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        null
    }

    /** The HandoffPayload schema, checked in code. */
    private fun payload(bytes: ByteArray): HandoffPayload? {
        if (bytes.size > 6144) return null
        val o = jsonObject(bytes) ?: return null
        if (!KEYS.containsAll(o.keys().asSequence().toSet())) return null
        if (int(o.opt("v")) != 1L) return null
        val kind = o.opt("kind") as? String ?: return null
        if (kind != KIND_MACHINE && kind != KIND_CONTROL_PLANE) return null
        val host = o.opt("host") as? String ?: return null
        if (!HOSTNAME.matches(host)) return null
        val jwt = o.opt("jwt") as? String ?: return null
        if (jwt.length > 4096 || !JWT.matches(jwt)) return null
        val email = o.opt("email") as? String ?: return null
        val at = email.indexOf('@')
        if (email.length > 254 || at < 1 || at == email.length - 1 || email.indexOf('@', at + 1) >= 0) return null
        val exp = int(o.opt("exp"))?.takeIf { it >= 0 } ?: return null
        val iat = int(o.opt("iat"))?.takeIf { it >= 0 } ?: return null
        val cookie = if (o.has("cookie")) (o.opt("cookie") as? String)?.takeIf { it.length in 1..4096 } ?: return null else null
        return HandoffPayload(kind, host, jwt, email, exp, iat, cookie)
    }

    private fun int(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> v
        is BigInteger -> if (v.bitLength() < 63) v.toLong() else null
        else -> null
    }
}
