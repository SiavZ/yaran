/**
 * Per-org Web Push keys for the relay-held FCM fallback (G5): a P-256 key, a 16-byte auth secret
 * and the relay registration id, wrapped with an AES-256-GCM key held by the Android Keystore,
 * the connector's own scheme.
 *
 * The FCM data message's `r` selects the org's keys, so orgs never decrypt each other's pushes
 * and forgetting an org deletes exactly its keys.
 *
 * - `WrapKeyProvider` is the seam: AndroidKeyStore in the app, a software key in Robolectric.
 * - Plain no-backup `SharedPreferences` hold only ciphertext; a restored blob cannot be
 *   unwrapped on another device, which is the intent (restored keys would be wrong keys).
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content, android.security.keystore, android.util, java.math, java.security, java.security.interfaces, java.security.spec, java.util, javax.crypto, javax.crypto.spec, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.relay.FcmRelayKeyStore
 * ├── io.github.siavz.yaran.push.PushPlugin
 * ├── io.github.siavz.yaran.push.fcmrelay.FcmRelayMessagingService
 * ├── io.github.siavz.yaran.push.relay.RelayFcmTest (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push.relay

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One org's relay keys; `publicKey` is the 65-byte uncompressed point (02 `p256dh`). */
class RelayKeys(val orgId: String, val registrationId: String, val privateKey: ECPrivateKey, val publicKey: ByteArray, val auth: ByteArray)

fun interface WrapKeyProvider {
    fun key(): SecretKey
}

/** The app's provider: one non-exportable AES key in the AndroidKeyStore. */
object KeystoreWrapKey : WrapKeyProvider {
    private const val ALIAS = "yaran.push.relay.wrap"

    override fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }
}

class FcmRelayKeyStore(context: Context, private val wrap: WrapKeyProvider = KeystoreWrapKey) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val random = SecureRandom()

    fun getOrCreate(orgId: String): RelayKeys = load(orgId) ?: create(orgId)

    /** A fresh key, auth secret and registration id (a re-mint). */
    fun create(orgId: String): RelayKeys {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), random) }.generateKeyPair()
        val auth = ByteArray(16).also(random::nextBytes)
        val keys = RelayKeys(orgId, UUID.randomUUID().toString(), pair.private as ECPrivateKey, uncompressed(pair.public as ECPublicKey), auth)
        val plain = JSONObject()
            .put("r", keys.registrationId)
            .put("d", b64(scalar(keys.privateKey)))
            .put("p", b64(keys.publicKey))
            .put("a", b64(auth))
            .toString().toByteArray(Charsets.UTF_8)
        prefs.edit().putString(orgId, seal(plain)).commit()
        return keys
    }

    fun load(orgId: String): RelayKeys? {
        val blob = prefs.getString(orgId, null) ?: return null
        val o = runCatching { JSONObject(String(open(blob), Charsets.UTF_8)) }.getOrNull() ?: return null
        val d = BigInteger(1, unb64(o.getString("d")))
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        val spec = ECPrivateKeySpec(d, params.getParameterSpec(ECParameterSpec::class.java))
        val priv = KeyFactory.getInstance("EC").generatePrivate(spec) as ECPrivateKey
        return RelayKeys(orgId, o.getString("r"), priv, unb64(o.getString("p")), unb64(o.getString("a")))
    }

    fun find(registrationId: String): RelayKeys? =
        prefs.all.keys.asSequence().mapNotNull { load(it) }.firstOrNull { it.registrationId == registrationId }

    fun delete(orgId: String) {
        prefs.edit().remove(orgId).commit()
    }

    private fun seal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, wrap.key()) }
        return b64(cipher.iv + cipher.doFinal(plain))
    }

    private fun open(blob: String): ByteArray {
        val bytes = unb64(blob)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrap.key(), GCMParameterSpec(128, bytes, 0, 12))
        return cipher.doFinal(bytes, 12, bytes.size - 12)
    }

    companion object {
        const val PREFS = "yaran_push_relay_keys"

        fun b64(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        fun unb64(text: String): ByteArray = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

        fun uncompressed(key: ECPublicKey): ByteArray =
            byteArrayOf(4) + fixed(key.w.affineX) + fixed(key.w.affineY)

        fun scalar(key: ECPrivateKey): ByteArray = fixed(key.s)

        private fun fixed(n: BigInteger): ByteArray {
            val raw = n.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            return ByteArray(32 - raw.size) + raw
        }
    }
}
