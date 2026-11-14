/**
 * SoftwareKeyProvider: an in-memory `KeyProvider` for the JVM tests, where AndroidKeyStore does not exist.
 *
 * Keys are plain AES-256 keys held in memory. The lock key needs no authentication here; the
 * tests call the vault's lock methods directly, which is exactly what `AppLock` does after a
 * successful `BiometricPrompt`. [invalidate] simulates a biometric enrolment change.
 *
 * - Test-only: it lives in the test source set so production can never wire it in.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.SoftwareKeyProvider
 * ├── io.github.siavz.yaran.core.KeyProvider (inferred)
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: javax.crypto, javax.crypto.spec
 *
 * Used by:
 * io.github.siavz.yaran.core.SoftwareKeyProvider
 * └── io.github.siavz.yaran.core.VaultTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SoftwareKeyProvider : KeyProvider {
    private var standard: SecretKey? = null
    private var lock: SecretKey? = null
    private var invalidated = false

    /** Makes the next [lockCipher] call fail the way a permanently invalidated keystore key does. */
    fun invalidate() {
        invalidated = true
    }

    val hasLockKey: Boolean get() = lock != null

    override fun standardKey(): SecretKey = standard ?: newKey().also { standard = it }

    override fun createLockKey(allowDeviceCredential: Boolean) {
        lock = newKey()
        invalidated = false
    }

    override fun lockCipher(
        mode: Int,
        iv: ByteArray?,
    ): Cipher {
        val key = lock ?: throw CoreError.Unavailable("no lock key")
        if (invalidated) throw CoreError.Invalidated("simulated biometric change")
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
        }
    }

    override fun deleteLockKey() {
        lock = null
    }

    override fun deleteAll() {
        standard = null
        lock = null
    }

    private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
}
