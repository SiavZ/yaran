/**
 * The device-key signature of a handoff request and the device key's fingerprint (02 §8.1, D24).
 *
 * Builds the five-line canonical string the per-org device key signs, converts the DER
 * signature Android Keystore returns into the 64-byte raw `r || s` (`EcdsaP256Sig`), and
 * computes `DeviceKeyFingerprint` (display and `fp24` forms) for diagnostics. Pinned by 02's
 * `sig/handoff-device-signature.json` and `sig/device-fingerprint.json`, and by
 * `fixtures/der-signatures.json`.
 *
 * - Pure. DER parsing is strict: one SEQUENCE of two minimal positive INTEGERs, nothing after.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.HandoffSignature
 * └── io.github.siavz.yaran.machineview.B64url (inferred)
 * External: java.math, java.security
 *
 * Used by:
 * io.github.siavz.yaran.machineview.HandoffSignature
 * ├── io.github.siavz.yaran.machineview.CryptoFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.math.BigInteger
import java.security.MessageDigest

internal object HandoffSignature {
    const val TAG = "yaran-handoff-device-v1"
    private const val KEY_TAG = "yaran-device-key-v1\n"
    private const val BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    fun canonical(host: String, pk: String, state: String, dts: Long): String = "$TAG\n$host\n$pk\n$state\n$dts\n"

    /** DER ECDSA signature -> base64url raw r||s, or null when the DER is not strict. */
    fun derToRawB64(der: ByteArray): String? = derToRaw(der)?.let { B64url.encode(it) }

    fun derToRaw(der: ByteArray): ByteArray? {
        if (der.size < 8 || der[0] != 0x30.toByte()) return null
        val len = der[1].toInt() and 0xff
        if (len >= 0x80 || len != der.size - 2) return null
        var pos = 2
        val out = ByteArray(64)
        for (half in 0..1) {
            if (pos + 2 > der.size || der[pos] != 0x02.toByte()) return null
            val n = der[pos + 1].toInt() and 0xff
            pos += 2
            if (n == 0 || n >= 0x80 || pos + n > der.size) return null
            var v = der.copyOfRange(pos, pos + n)
            pos += n
            if (v[0].toInt() and 0x80 != 0) return null
            if (v.size > 1 && v[0] == 0.toByte()) {
                if (v[1].toInt() and 0x80 == 0) return null
                v = v.copyOfRange(1, v.size)
            }
            if (v.size > 32) return null
            v.copyInto(out, half * 32 + 32 - v.size)
        }
        return if (pos == der.size) out else null
    }

    /** Raw r||s -> DER, for JCA verification. */
    fun rawToDer(raw: ByteArray): ByteArray {
        require(raw.size == 64)
        fun int(b: ByteArray): ByteArray {
            val n = BigInteger(1, b).toByteArray()
            return byteArrayOf(0x02, n.size.toByte()) + n
        }
        val body = int(raw.copyOfRange(0, 32)) + int(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    fun fingerprint24(point: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(KEY_TAG.toByteArray(Charsets.US_ASCII) + point)
        val out = StringBuilder()
        var acc = 0
        var bits = 0
        for (b in digest.copyOf(15)) {
            acc = (acc shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                out.append(BASE32[acc shr bits and 31])
            }
            acc = acc and ((1 shl bits) - 1)
        }
        return out.toString()
    }

    fun displayFingerprint(fp24: String): String = fp24.chunked(4).joinToString("-")
}
