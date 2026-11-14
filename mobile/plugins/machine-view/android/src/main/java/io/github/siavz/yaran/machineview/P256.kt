/**
 * P-256 point handling shared by the envelope opener and the device-key code (02 §8, §8.1).
 *
 * Decodes and validates the 65-byte uncompressed SEC1 points the protocol carries as
 * `P256Point`, with the explicit on-curve check the opener obligations require before any
 * key agreement, and converts between that form and JCA keys.
 *
 * - Pure JCA; no Android types, so it runs in JVM tests.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.P256
 * └── io.github.siavz.yaran.machineview.B64url (inferred)
 * External: java.math, java.security, java.security.interfaces, java.security.spec
 *
 * Used by:
 * io.github.siavz.yaran.machineview.P256
 * ├── io.github.siavz.yaran.machineview.AndroidKeyStoreBackend (inferred)
 * ├── io.github.siavz.yaran.machineview.CryptoFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

internal object P256 {
    private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    val N = BigInteger("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

    val params: ECParameterSpec by lazy {
        AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
    }

    fun isOnCurve(x: ByteArray, y: ByteArray): Boolean {
        if (x.size != 32 || y.size != 32) return false
        val bx = BigInteger(1, x)
        val by = BigInteger(1, y)
        if (bx >= P || by >= P) return false
        val left = by.multiply(by).mod(P)
        val right = bx.pow(3).subtract(bx.multiply(BigInteger.valueOf(3))).add(B).mod(P)
        return left == right
    }

    /** The validated 65-byte point of a `P256Point` string, or null. */
    fun decodePoint(text: String): ByteArray? {
        val raw = B64url.decode(text) ?: return null
        if (raw.size != 65 || raw[0] != 4.toByte()) return null
        return if (isOnCurve(raw.copyOfRange(1, 33), raw.copyOfRange(33, 65))) raw else null
    }

    fun publicKey(point: ByteArray): ECPublicKey {
        val spec = ECPublicKeySpec(ECPoint(BigInteger(1, point.copyOfRange(1, 33)), BigInteger(1, point.copyOfRange(33, 65))), params)
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }

    fun encodePoint(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + fixed32(key.w.affineX) + fixed32(key.w.affineY)

    fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray()
        return when {
            b.size == 32 -> b
            b.size == 33 && b[0] == 0.toByte() -> b.copyOfRange(1, 33)
            b.size < 32 -> ByteArray(32 - b.size) + b
            else -> throw IllegalArgumentException("integer does not fit in 32 bytes")
        }
    }

    /** RFC 7638 thumbprint of the point's JWK, base64url. */
    fun thumbprint(point: ByteArray): String {
        val x = B64url.encode(point.copyOfRange(1, 33))
        val y = B64url.encode(point.copyOfRange(33, 65))
        val canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"$x\",\"y\":\"$y\"}"
        return B64url.encode(MessageDigest.getInstance("SHA-256").digest(canonical.toByteArray(Charsets.US_ASCII)))
    }
}
