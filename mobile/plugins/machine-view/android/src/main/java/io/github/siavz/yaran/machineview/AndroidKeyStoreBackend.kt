/**
 * [DeviceKeyBackend] over AndroidKeyStore: StrongBox first, then the TEE (D24).
 *
 * Generates a `PURPOSE_SIGN` secp256r1 key with `DIGEST_SHA256` and no user authentication
 * (the consent page is the human check). StrongBox is requested on API 28+ and a
 * `StrongBoxUnavailableException` or a StrongBox `ProviderException` retries in the TEE
 * ([KeyGenFallback], unit-tested under Robolectric). Where neither exists the platform falls
 * back to a software-backed, still non-exportable Keystore key. Keystore keys are never backed
 * up and are deleted on uninstall.
 *
 * - Device only; the JVM tests use a software backend instead (Robolectric has no Keystore),
 *   and test the fallback rule through [KeyGenFallback].
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.AndroidKeyStoreBackend
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * └── io.github.siavz.yaran.machineview.P256 (inferred)
 * External: android.os, android.security.keystore, java.security, java.security.interfaces, java.security.spec
 *
 * Used by:
 * io.github.siavz.yaran.machineview.AndroidKeyStoreBackend
 * ├── io.github.siavz.yaran.machineview.KeyGenFallbackRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

internal class AndroidKeyStoreBackend : DeviceKeyBackend {
    private val store: KeyStore by lazy { KeyStore.getInstance(PROVIDER).apply { load(null) } }

    override fun exists(alias: String) = store.containsAlias(alias)

    override fun generate(alias: String): SecurityLevel {
        KeyGenFallback.generate(Build.VERSION.SDK_INT, { strongBox -> create(alias, strongBox) }, { delete(alias) })
        return level(alias)
    }

    private fun create(alias: String, strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER).apply { initialize(spec.build()) }.generateKeyPair()
    }

    override fun level(alias: String): SecurityLevel {
        val key = store.getKey(alias, null) as PrivateKey
        val info = KeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> SecurityLevel.STRONGBOX
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> SecurityLevel.TEE
                else -> SecurityLevel.SOFTWARE
            }
        }
        @Suppress("DEPRECATION")
        return if (info.isInsideSecureHardware) SecurityLevel.TEE else SecurityLevel.SOFTWARE
    }

    override fun publicPoint(alias: String): ByteArray = P256.encodePoint(store.getCertificate(alias).publicKey as ECPublicKey)

    override fun signDer(alias: String, data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").apply {
            initSign(store.getKey(alias, null) as PrivateKey)
            update(data)
        }.sign()

    override fun delete(alias: String) {
        if (store.containsAlias(alias)) store.deleteEntry(alias)
    }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
    }
}

/**
 * StrongBox first, then the TEE: a device without StrongBox says so with
 * [StrongBoxUnavailableException], and some StrongBox implementations fail generation with a
 * plain [ProviderException] instead (the half-made entry is removed before the retry). A TEE
 * failure is not caught: the caller reports it as a storage failure, never as a locked vault.
 */
internal object KeyGenFallback {
    fun generate(sdk: Int, create: (strongBox: Boolean) -> Unit, cleanup: () -> Unit) {
        if (sdk >= Build.VERSION_CODES.P) {
            try {
                create(true)
                return
            } catch (e: StrongBoxUnavailableException) {
                // No StrongBox on this device: retry in the TEE.
            } catch (e: ProviderException) {
                cleanup()
            }
        }
        create(false)
    }
}
