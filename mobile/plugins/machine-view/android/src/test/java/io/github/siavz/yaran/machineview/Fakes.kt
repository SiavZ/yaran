/**
 * In-memory fakes of Phase 14's core seams and a software device-key backend for JVM tests.
 *
 * The fake vault records every write so tests can prove no key material is ever stored; the
 * software backend is a JCA P-256 key standing in for AndroidKeyStore (Robolectric has none);
 * [TestSealer] seals handoff payloads the way 02's servers do, so the client's whole path runs.
 *
 * - Test only.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.Fakes
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * └── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * External: java.security, java.security.interfaces, java.security.spec, javax.crypto, javax.crypto.spec, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Fakes
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONObject
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class FakeVault : SecretVault {
    val data = linkedMapOf<String, ByteArray>()
    val classes = linkedMapOf<String, ProtectionClass>()
    val writes = mutableListOf<Pair<String, String>>()
    var locked = false

    override fun read(ns: String): ByteArray? {
        if (locked && classes[ns] == ProtectionClass.LOCKED) throw VaultLockedException()
        return data[ns]
    }

    override fun write(ns: String, value: ByteArray, cls: ProtectionClass) {
        if (locked && cls == ProtectionClass.LOCKED) throw VaultLockedException()
        data[ns] = value
        classes[ns] = cls
        writes += ns to String(value)
    }

    override fun delete(ns: String) {
        data.remove(ns)
        classes.remove(ns)
    }

    override fun list(prefix: String) = data.keys.filter { it.startsWith(prefix) }
}

class FakeDiagnostics : DiagnosticsSink {
    val lines = mutableListOf<String>()

    override fun append(line: String) {
        lines += line
    }
}

class FakeLock(var enabled: Boolean = false) : AppLockState {
    override fun lockEnabled() = enabled

    override fun isLocked() = false
}

class SoftwareKeyBackend(private val level: SecurityLevel = SecurityLevel.TEE) : DeviceKeyBackend {
    val keys = linkedMapOf<String, KeyPair>()

    override fun exists(alias: String) = alias in keys

    override fun generate(alias: String): SecurityLevel {
        keys[alias] = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        return level
    }

    override fun level(alias: String) = level

    override fun publicPoint(alias: String) = P256.encodePoint(keys.getValue(alias).public as ECPublicKey)

    override fun signDer(alias: String, data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").apply { initSign(keys.getValue(alias).private); update(data) }.sign()

    override fun delete(alias: String) {
        keys.remove(alias)
    }
}

object TestSealer {
    /** Seals [payload] to [pk] for [host]/[state], as the W16/Y1 servers do (02 §8). */
    fun seal(pk: String, host: String, state: String, payload: JSONObject, kid: String? = null): String {
        val point = P256.decodePoint(pk)!!
        val eph = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val ephPoint = P256.encodePoint(eph.public as ECPublicKey)
        val header = JSONObject().put("alg", "ECDH-ES").put("enc", "A256GCM").put("typ", "yaran-handoff+jwe")
            .put("cty", "yaran-handoff+json").put("kid", kid ?: P256.thumbprint(point))
            .put("epk", JSONObject().put("kty", "EC").put("crv", "P-256")
                .put("x", B64url.encode(ephPoint.copyOfRange(1, 33))).put("y", B64url.encode(ephPoint.copyOfRange(33, 65))))
            .put("apu", B64url.encode(host.toByteArray())).put("apv", B64url.encode(state.toByteArray()))
        val headerB64 = B64url.encode(header.toString().toByteArray())
        val z = KeyAgreement.getInstance("ECDH").run { init(eph.private); doPhase(P256.publicKey(point), true); generateSecret() }
        val cek = SealedEnvelope.concatKdf(z, "A256GCM", host.toByteArray(), state.toByteArray(), 256)
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val out = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, iv))
            updateAAD(headerB64.toByteArray())
            doFinal(payload.toString().toByteArray())
        }
        return listOf(headerB64, "", B64url.encode(iv), B64url.encode(out.copyOf(out.size - 16)), B64url.encode(out.copyOfRange(out.size - 16, out.size))).joinToString(".")
    }

    fun jwt(exp: Long) = "eyJhbGciOiJSUzI1NiJ9." + B64url.encode("{\"exp\":$exp,\"email\":\"ada@example.org\"}".toByteArray()) + ".c2ln"

    fun payload(kind: String, host: String, exp: Long, iat: Long, jwtExp: Long = exp): JSONObject =
        JSONObject().put("v", 1).put("kind", kind).put("host", host).put("jwt", jwt(jwtExp)).put("email", "ada@example.org").put("exp", exp).put("iat", iat)
}
