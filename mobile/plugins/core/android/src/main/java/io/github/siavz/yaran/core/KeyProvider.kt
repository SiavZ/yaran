/**
 * KeyProvider: the seam between the vault and the platform keystore.
 *
 * The vault never touches AndroidKeyStore directly; it asks a `KeyProvider` for the
 * device-bound standard key and for ciphers on the auth-per-use lock key. Production uses
 * `AndroidKeyStoreKeyProvider`; the JVM tests swap in a software provider because Robolectric
 * has no AndroidKeyStore.
 *
 * - Both keys are AES-256-GCM, non-exportable, StrongBox-backed when the device has StrongBox.
 * - The lock key requires user authentication for every use (biometric, plus the device
 *   credential on API 30+ when the user allows it) and is invalidated by a new enrolment;
 *   an invalidated key surfaces as `CoreError.Invalidated`, never as a raw platform exception.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.KeyProvider
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: android.content, android.content.pm, android.os, android.security.keystore, java.security, javax.crypto, javax.crypto.spec
 *
 * Used by:
 * io.github.siavz.yaran.core.KeyProvider
 * ├── io.github.siavz.yaran.core.AndroidKeyStoreTest (inferred)
 * ├── io.github.siavz.yaran.core.SoftwareKeyProvider (inferred)
 * ├── io.github.siavz.yaran.core.Vault (inferred)
 * └── io.github.siavz.yaran.machineview.CoreAdaptersTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/** Supplies the vault's keys. Every failure is a [CoreError]. */
interface KeyProvider {
    /** The device-bound vault key that needs no user authentication, created on first use. */
    fun standardKey(): SecretKey

    /** Creates the auth-per-use lock key, replacing any previous one. */
    fun createLockKey(allowDeviceCredential: Boolean)

    /**
     * A cipher on the lock key: [Cipher.ENCRYPT_MODE] with a fresh IV, or [Cipher.DECRYPT_MODE]
     * with [iv]. It still needs a successful user authentication before it can be used.
     */
    fun lockCipher(
        mode: Int,
        iv: ByteArray?,
    ): Cipher

    /** Deletes the lock key; a no-op when there is none. */
    fun deleteLockKey()

    /** Deletes every key this provider owns. */
    fun deleteAll()
}

/** [KeyProvider] over AndroidKeyStore. */
class AndroidKeyStoreKeyProvider(
    private val context: Context,
) : KeyProvider {
    private val keyStore: KeyStore by lazy { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) } }

    override fun standardKey(): SecretKey =
        guarded {
            existing(STANDARD_ALIAS) ?: generate(STANDARD_ALIAS) { it }
        }

    override fun createLockKey(allowDeviceCredential: Boolean) {
        guarded {
            deleteLockKey()
            generate(LOCK_ALIAS) { builder ->
                builder.setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val types =
                        if (allowDeviceCredential) {
                            KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL
                        } else {
                            KeyProperties.AUTH_BIOMETRIC_STRONG
                        }
                    builder.setUserAuthenticationParameters(0, types)
                } else {
                    @Suppress("DEPRECATION")
                    builder.setUserAuthenticationValidityDurationSeconds(-1)
                }
            }
        }
    }

    override fun lockCipher(
        mode: Int,
        iv: ByteArray?,
    ): Cipher {
        val key = guarded { existing(LOCK_ALIAS) } ?: throw CoreError.Unavailable("the app-lock key does not exist")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        try {
            if (iv == null) cipher.init(mode, key) else cipher.init(mode, key, GCMParameterSpec(TAG_BITS, iv))
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw CoreError.Invalidated("the app-lock key was invalidated by a biometric change", e)
        } catch (e: GeneralSecurityException) {
            throw CoreError.Unavailable("the app-lock key cannot be used", e)
        }
        return cipher
    }

    override fun deleteLockKey() {
        guarded { if (keyStore.containsAlias(LOCK_ALIAS)) keyStore.deleteEntry(LOCK_ALIAS) }
    }

    override fun deleteAll() {
        guarded { listOf(STANDARD_ALIAS, LOCK_ALIAS).filter(keyStore::containsAlias).forEach(keyStore::deleteEntry) }
    }

    /** The platform's description of a key, for the instrumented tests; null when absent. */
    fun keyInfo(lockKey: Boolean): KeyInfo? =
        guarded {
            existing(if (lockKey) LOCK_ALIAS else STANDARD_ALIAS)?.let { key ->
                SecretKeyFactory.getInstance(key.algorithm, ANDROID_KEYSTORE).getKeySpec(key, KeyInfo::class.java) as KeyInfo
            }
        }

    private fun existing(alias: String): SecretKey? = keyStore.getKey(alias, null) as SecretKey?

    private fun generate(
        alias: String,
        customise: (KeyGenParameterSpec.Builder) -> KeyGenParameterSpec.Builder,
    ): SecretKey {
        fun spec(strongBox: Boolean): KeyGenParameterSpec {
            val builder =
                KeyGenParameterSpec
                    .Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(KEY_BITS)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) builder.setIsStrongBoxBacked(true)
            return customise(builder).build()
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        if (hasStrongBox()) {
            try {
                generator.init(spec(strongBox = true))
                return generator.generateKey()
            } catch (_: StrongBoxUnavailableException) {
                // StrongBox advertised but refused this key shape; fall back to the TEE.
            }
        }
        generator.init(spec(strongBox = false))
        return generator.generateKey()
    }

    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private inline fun <T> guarded(block: () -> T): T =
        try {
            block()
        } catch (e: CoreError) {
            throw e
        } catch (e: GeneralSecurityException) {
            throw CoreError.Unavailable("the Android keystore failed", e)
        } catch (e: java.io.IOException) {
            throw CoreError.Unavailable("the Android keystore failed", e)
        } catch (e: IllegalStateException) {
            // Thrown by key generation when no secure lock screen or biometric is set up.
            throw CoreError.Unavailable("the Android keystore refused the key", e)
        }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val STANDARD_ALIAS = "yaran.vault.standard"
        const val LOCK_ALIAS = "yaran.vault.lock"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_BITS = 256
        const val TAG_BITS = 128
    }
}
