/**
 * Unpadded base64url (RFC 4648 §5) for keys, states, signatures and JWE parts.
 *
 * `java.util.Base64` needs API 26 and `android.util.Base64` is a stub in JVM tests, while
 * minSdk is 24, so the codec is written out. Decoding is strict: no padding, no whitespace,
 * no characters outside the url-safe alphabet, and no non-canonical trailing bits.
 *
 * - Pure; decode returns null instead of throwing.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.B64url
 * ├── io.github.siavz.yaran.machineview.CryptoFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffSignature (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * ├── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal object B64url {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    fun encode(bytes: ByteArray): String {
        val out = StringBuilder((bytes.size * 4 + 2) / 3)
        var i = 0
        while (i + 3 <= bytes.size) {
            val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8) or (bytes[i + 2].toInt() and 0xff)
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
                .append(ALPHABET[n shr 6 and 63]).append(ALPHABET[n and 63])
            i += 3
        }
        when (bytes.size - i) {
            1 -> {
                val n = bytes[i].toInt() and 0xff shl 16
                out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
            }
            2 -> {
                val n = (bytes[i].toInt() and 0xff shl 16) or (bytes[i + 1].toInt() and 0xff shl 8)
                out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63]).append(ALPHABET[n shr 6 and 63])
            }
        }
        return out.toString()
    }

    fun decode(text: String): ByteArray? {
        if (text.length % 4 == 1) return null
        val out = java.io.ByteArrayOutputStream(text.length * 3 / 4)
        var acc = 0
        var bits = 0
        for (c in text) {
            val v = ALPHABET.indexOf(c)
            if (v < 0) return null
            acc = (acc shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write(acc shr bits and 0xff)
            }
            acc = acc and ((1 shl bits) - 1)
        }
        if (acc != 0) return null
        return out.toByteArray()
    }
}
