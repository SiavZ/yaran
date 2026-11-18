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
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.machineview.B64url (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * ├── io.github.siavz.yaran.machineview.P256 (inferred)
 * └── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * External: java.security, java.security.interfaces, java.security.spec, javax.crypto, javax.crypto.spec, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Fakes
 * ├── io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AuthTabRegistryRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdaptersTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuthTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFixtureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.FreshSignInRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffFailureTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeCookieIsolationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SignInLockRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * ├── io.github.siavz.yaran.machineview.UpgradeRequiredRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowRepairRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.WindowRound12RobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import io.github.siavz.yaran.core.ActivityForeground
import io.github.siavz.yaran.core.LockGrace
import io.github.siavz.yaran.core.LockTimer
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
    val reads = mutableListOf<String>()
    var locked = false

    override fun read(ns: String): ByteArray? {
        reads += ns
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

/** App Lock over core's real [LockTimer]; [tracker] is `AppLock.trackActivities`' wiring with this lock behind it. */
class FakeLock(var enabled: Boolean = false, locked: Boolean = false) : AppLockState {
    var prompts = 0

    /** What the next prompt does: true unlocks, false is a cancel. */
    var promptUnlocks = true
    var now = 0L
    var grace = LockGrace.ONE_MINUTE
    var timer = LockTimer()

    /** A vault whose locked class follows this lock, as the core vault's does. */
    var vault: FakeVault? = null
    var locked = locked
        set(value) {
            field = value
            vault?.locked = value
        }

    override fun lockEnabled() = enabled

    override fun isLocked() = locked

    override fun unlock(activity: androidx.fragment.app.FragmentActivity, done: () -> Unit) {
        prompts++
        if (promptUnlocks) {
            locked = false
            timer.present()
        }
        done()
    }

    override fun holdForExternalFlow(ttlMs: Long) = timer.hold(now, ttlMs)

    override fun releaseExternalFlow() = timer.release()

    /** `AppLock.onForeground` / `onBackground` over this lock. */
    fun tracker() = ActivityForeground({ if (timer.foreground(now, grace) && !locked && enabled) locked = true }, { timer.background(now) })
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

/** PluginRuntime is one per process and outlives a test class: every window test drives these. */
object TestBindings {
    val lock = FakeLock()
    val vault = FakeVault()
}

/**
 * A yaran on loopback HTTPS answering every status request with [body] (by default a build
 * whose page signs in natively, no password needed): what an org window's admission probe
 * reaches. No request leaves the machine; [requests] counts them.
 */
internal class FakeYaran(var body: JSONObject = capableStatus()) : AutoCloseable {
    /** What a request carrying a session cookie gets instead of [body], when set. */
    @Volatile var signedBody: JSONObject? = null

    /** True: every connection is dropped, as an unreachable machine's would be. */
    @Volatile var offline = false
    private val cert = okhttp3.tls.HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val trust = okhttp3.tls.HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
    private val server = okhttp3.mockwebserver.MockWebServer().apply {
        useHttps(okhttp3.tls.HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false)
        dispatcher = object : okhttp3.mockwebserver.Dispatcher() {
            override fun dispatch(request: okhttp3.mockwebserver.RecordedRequest) = if (offline) {
                okhttp3.mockwebserver.MockResponse().setSocketPolicy(okhttp3.mockwebserver.SocketPolicy.DISCONNECT_AT_START)
            } else {
                okhttp3.mockwebserver.MockResponse().setHeader("Content-Type", "application/json")
                    .setBody(((if (request.getHeader("Cookie") != null) signedBody else null) ?: body).toString())
            }
        }
        start()
    }
    val requests get() = server.requestCount
    val auth = DirectAuth("YaranApp/1.0.0 (android; phone)", FakeDiagnostics()) { url ->
        (java.net.URL("https", "localhost", server.port, url.file).openConnection() as javax.net.ssl.HttpsURLConnection)
            .apply { sslSocketFactory = trust.sslSocketFactory() }
    }

    override fun close() = server.shutdown()

    companion object {
        fun capableStatus(capable: Boolean = true): JSONObject = JSONObject().put("password_set", false).put("required_here", false)
            .put("signed_in", false).put("client_class", "network").put("transport_encrypted", true).put("instance", JSONObject.NULL)
            .apply { if (capable) put("native_auth_ui", true) }
    }
}
