/**
 * Vault: namespaced, encrypted string storage on the device, in two protection classes.
 *
 * Each namespace is one AES-256-GCM blob at `<dir>/<namespace>.bin` (production: under
 * `noBackupFilesDir/vault`), sealed with the device-bound standard key and bound to its
 * namespace through the GCM associated data, so a blob moved to another name fails to open.
 * Entries in the `locked` class are sealed a second time with a data key that the app-lock
 * key wraps while the lock is on (the standard key wraps it while the lock is off), so they
 * cannot be read until the user authenticates.
 *
 * - Every failure is a [CoreError]; a GCM tag failure is `tampered`, never an empty result.
 * - All operations are serialised on the instance; writes go through a temp file and rename.
 * - The lock state (`isLockWrapped`) is derived from the wrapped data key on disk, so erasing
 *   the vault or wiping an invalidated lock also turns the lock off.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.Vault
 * └── io.github.siavz.yaran.core.KeyProvider (inferred)
 * External: android.content, java.io, java.security, javax.crypto, javax.crypto.spec
 *
 * Used by:
 * io.github.siavz.yaran.core.Vault
 * ├── io.github.siavz.yaran.core.AndroidKeyStoreTest (inferred)
 * ├── io.github.siavz.yaran.core.AppLock (inferred)
 * ├── io.github.siavz.yaran.core.KeyProvider (inferred)
 * ├── io.github.siavz.yaran.core.SoftwareKeyProvider (inferred)
 * ├── io.github.siavz.yaran.core.VaultTest (inferred)
 * ├── io.github.siavz.yaran.securestore.BuildInfoPlugin
 * ├── io.github.siavz.yaran.securestore.DiagnosticsPlugin
 * ├── io.github.siavz.yaran.securestore.SecureStorePlugin
 * ├── io.github.siavz.yaran.securestore.Validation
 * └── io.github.siavz.yaran.securestore.ValidationTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.content.Context
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** The stable error set of the native core; [code] is what the adapters reject with. */
sealed class CoreError(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause) {
    class Tampered(
        message: String,
        cause: Throwable? = null,
    ) : CoreError("tampered", message, cause)

    class Invalidated(
        message: String,
        cause: Throwable? = null,
    ) : CoreError("invalidated", message, cause)

    class Locked(
        message: String,
    ) : CoreError("locked", message)

    class Unavailable(
        message: String,
        cause: Throwable? = null,
    ) : CoreError("unavailable", message, cause)

    class InvalidArgument(
        message: String,
    ) : CoreError("invalid_argument", message)
}

/** `standard`: device-bound, no user auth. `locked`: wrapped by the app-lock key when it is on. */
enum class Protection(
    val code: String,
) {
    STANDARD("standard"),
    LOCKED("locked"),
    ;

    companion object {
        fun parse(code: String): Protection? = entries.firstOrNull { it.code == code }
    }
}

class Vault(
    private val dir: File,
    private val keys: KeyProvider,
) {
    private class Entry(
        val protection: Protection,
        val bytes: ByteArray,
    )

    private val random = SecureRandom()
    private var dataKey: SecretKey? = null

    /** The value under [key], or null when there is none. */
    @Synchronized
    fun get(
        namespace: String,
        key: String,
    ): String? {
        checkNames(namespace, key)
        val entry = read(namespace)[key] ?: return null
        return when (entry.protection) {
            Protection.STANDARD -> entry.bytes.decodeToString()
            Protection.LOCKED -> unseal(requireDataKey(), entry.bytes, lockedAad(namespace, key)).decodeToString()
        }
    }

    @Synchronized
    fun set(
        namespace: String,
        key: String,
        value: String,
        protection: Protection,
    ) {
        checkNames(namespace, key)
        val entries = read(namespace).toMutableMap()
        val bytes = value.encodeToByteArray()
        entries[key] =
            when (protection) {
                Protection.STANDARD -> Entry(protection, bytes)
                Protection.LOCKED -> Entry(protection, seal(requireDataKey(), bytes, lockedAad(namespace, key)))
            }
        write(namespace, entries)
    }

    @Synchronized
    fun remove(
        namespace: String,
        key: String,
    ) {
        checkNames(namespace, key)
        val entries = read(namespace).toMutableMap()
        if (entries.remove(key) != null) write(namespace, entries)
    }

    /** The keys stored in [namespace], sorted; readable while the lock is engaged. */
    @Synchronized
    fun list(namespace: String): List<String> {
        checkNames(namespace, null)
        return read(namespace).keys.sorted()
    }

    /** Deletes every namespace, the wrapped data key and every keystore key. */
    @Synchronized
    fun eraseAll() {
        dataKey = null
        dir.listFiles()?.forEach { it.delete() }
        keys.deleteAll()
    }

    /** True while the app-lock key wraps the locked class, i.e. the lock is enabled. */
    @Synchronized
    fun isLockWrapped(): Boolean = readWrappedKey()?.first == WRAP_LOCK

    /** True when the locked class can be read without authenticating. */
    @Synchronized
    fun isUnlocked(): Boolean = dataKey != null || !isLockWrapped()

    /** An ENCRYPT cipher on a freshly created lock key, to authenticate before [wrapUnderLock]. */
    fun lockCipherForEnable(allowDeviceCredential: Boolean): Cipher {
        keys.createLockKey(allowDeviceCredential)
        return keys.lockCipher(Cipher.ENCRYPT_MODE, null)
    }

    /**
     * A DECRYPT cipher on the lock key, to authenticate before [unlock]. When the key was
     * invalidated the locked class is wiped first and [CoreError.Invalidated] is rethrown.
     */
    @Synchronized
    fun lockCipherForUnlock(): Cipher {
        val (wrapper, blob) = readWrappedKey() ?: throw CoreError.Unavailable("the app lock is not enabled")
        if (wrapper != WRAP_LOCK) throw CoreError.Unavailable("the app lock is not enabled")
        if (blob.size < IV_BYTES) throw CoreError.Tampered("the wrapped data key is truncated")
        return try {
            keys.lockCipher(Cipher.DECRYPT_MODE, blob.copyOfRange(0, IV_BYTES))
        } catch (e: CoreError.Invalidated) {
            wipeLocked()
            throw e
        }
    }

    /** Unwraps the data key with an authenticated cipher from [lockCipherForUnlock]. */
    @Synchronized
    fun unlock(authenticated: Cipher) {
        val (_, blob) = readWrappedKey() ?: throw CoreError.Unavailable("the app lock is not enabled")
        val raw =
            guardedOpen {
                authenticated.updateAAD(DATA_KEY_AAD)
                authenticated.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
            }
        dataKey = SecretKeySpec(raw, "AES")
    }

    /** Re-wraps the data key with an authenticated cipher from [lockCipherForEnable]. */
    @Synchronized
    fun wrapUnderLock(authenticated: Cipher) {
        val key = requireDataKey()
        val sealed =
            guardedSeal {
                authenticated.updateAAD(DATA_KEY_AAD)
                authenticated.doFinal(key.encoded)
            }
        writeWrappedKey(WRAP_LOCK, authenticated.iv + sealed)
    }

    /** Re-wraps the data key under the standard key; the lock key can then be deleted. */
    @Synchronized
    fun wrapUnderStandard() {
        val key = requireDataKey()
        writeWrappedKey(WRAP_STANDARD, seal(keys.standardKey(), key.encoded, DATA_KEY_AAD))
    }

    /** Deletes the lock key alone: after a cancelled enable, or once [wrapUnderStandard] ran. */
    fun deleteLockKey() = keys.deleteLockKey()

    /** Forgets the unwrapped data key, so the locked class needs authentication again. */
    @Synchronized
    fun relock() {
        if (isLockWrapped()) dataKey = null
    }

    /** Deletes every locked-class entry, the wrapped data key and the lock key. */
    @Synchronized
    fun wipeLocked() {
        dataKey = null
        File(dir, DATA_KEY_FILE).delete()
        keys.deleteLockKey()
        namespaceFiles().forEach { file ->
            val namespace = file.name.removeSuffix(BLOB_SUFFIX)
            try {
                val entries = read(namespace)
                val kept = entries.filterValues { it.protection == Protection.STANDARD }
                if (kept.size != entries.size) write(namespace, kept)
            } catch (_: CoreError.Tampered) {
                // A tampered namespace stays tampered; the wipe carries on with the others.
            }
        }
    }

    private fun requireDataKey(): SecretKey {
        dataKey?.let { return it }
        val wrapped = readWrappedKey()
        if (wrapped == null) {
            val fresh = ByteArray(KEY_BYTES).also(random::nextBytes)
            writeWrappedKey(WRAP_STANDARD, seal(keys.standardKey(), fresh, DATA_KEY_AAD))
            return SecretKeySpec(fresh, "AES").also { dataKey = it }
        }
        if (wrapped.first == WRAP_LOCK) throw CoreError.Locked("the app lock is engaged")
        return SecretKeySpec(unseal(keys.standardKey(), wrapped.second, DATA_KEY_AAD), "AES").also { dataKey = it }
    }

    private fun read(namespace: String): Map<String, Entry> {
        val file = File(dir, namespace + BLOB_SUFFIX)
        if (!file.exists()) return emptyMap()
        val plain = unseal(keys.standardKey(), readBytes(file), blobAad(namespace))
        return try {
            DataInputStream(ByteArrayInputStream(plain)).use { input ->
                val entries = LinkedHashMap<String, Entry>()
                repeat(input.readInt()) {
                    val key = input.readUTF()
                    val protection =
                        Protection.entries.getOrNull(input.readByte().toInt())
                            ?: throw CoreError.Tampered("unknown protection class in namespace $namespace")
                    entries[key] = Entry(protection, ByteArray(input.readInt()).also(input::readFully))
                }
                entries
            }
        } catch (e: IOException) {
            throw CoreError.Tampered("namespace $namespace is malformed", e)
        }
    }

    private fun write(
        namespace: String,
        entries: Map<String, Entry>,
    ) {
        val file = File(dir, namespace + BLOB_SUFFIX)
        if (entries.isEmpty()) {
            file.delete()
            return
        }
        val buffer = ByteArrayOutputStream()
        DataOutputStream(buffer).use { out ->
            out.writeInt(entries.size)
            entries.forEach { (key, entry) ->
                out.writeUTF(key)
                out.writeByte(entry.protection.ordinal)
                out.writeInt(entry.bytes.size)
                out.write(entry.bytes)
            }
        }
        writeAtomically(file, seal(keys.standardKey(), buffer.toByteArray(), blobAad(namespace)))
    }

    private fun readWrappedKey(): Pair<Byte, ByteArray>? {
        val file = File(dir, DATA_KEY_FILE)
        if (!file.exists()) return null
        val bytes = readBytes(file)
        if (bytes.isEmpty() || (bytes[0] != WRAP_STANDARD && bytes[0] != WRAP_LOCK)) {
            throw CoreError.Tampered("the wrapped data key is malformed")
        }
        return bytes[0] to bytes.copyOfRange(1, bytes.size)
    }

    private fun writeWrappedKey(
        wrapper: Byte,
        blob: ByteArray,
    ) = writeAtomically(File(dir, DATA_KEY_FILE), byteArrayOf(wrapper) + blob)

    /** `IV || ciphertext+tag` under [key] with [aad]. */
    private fun seal(
        key: SecretKey,
        plain: ByteArray,
        aad: ByteArray,
    ): ByteArray =
        guardedSeal {
            val iv = ByteArray(IV_BYTES).also(random::nextBytes)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            if (key is SecretKeySpec) {
                cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
            } else {
                // Keystore keys require randomized encryption: the keystore picks the IV.
                cipher.init(Cipher.ENCRYPT_MODE, key)
            }
            cipher.updateAAD(aad)
            val sealed = cipher.doFinal(plain)
            (cipher.iv ?: iv) + sealed
        }

    private fun unseal(
        key: SecretKey,
        blob: ByteArray,
        aad: ByteArray,
    ): ByteArray {
        if (blob.size < IV_BYTES + TAG_BITS / Byte.SIZE_BITS) throw CoreError.Tampered("a vault blob is truncated")
        return guardedOpen {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES))
            cipher.updateAAD(aad)
            cipher.doFinal(blob, IV_BYTES, blob.size - IV_BYTES)
        }
    }

    private inline fun <T> guardedOpen(block: () -> T): T =
        try {
            block()
        } catch (e: AEADBadTagException) {
            throw CoreError.Tampered("a vault blob failed its integrity check", e)
        } catch (e: GeneralSecurityException) {
            throw CoreError.Unavailable("decryption failed", e)
        }

    private inline fun <T> guardedSeal(block: () -> T): T =
        try {
            block()
        } catch (e: GeneralSecurityException) {
            throw CoreError.Unavailable("encryption failed", e)
        }

    private fun readBytes(file: File): ByteArray =
        try {
            file.readBytes()
        } catch (e: IOException) {
            throw CoreError.Unavailable("cannot read ${file.name}", e)
        }

    private fun writeAtomically(
        file: File,
        bytes: ByteArray,
    ) {
        try {
            dir.mkdirs()
            val temp = File(dir, file.name + ".tmp")
            temp.writeBytes(bytes)
            if (!temp.renameTo(file)) throw IOException("rename to ${file.name} failed")
        } catch (e: IOException) {
            throw CoreError.Unavailable("cannot write ${file.name}", e)
        }
    }

    private fun namespaceFiles(): List<File> = dir.listFiles { file -> file.name.endsWith(BLOB_SUFFIX) }?.toList().orEmpty()

    private fun blobAad(namespace: String) = "yaran-vault:v1:$namespace".encodeToByteArray()

    private fun lockedAad(
        namespace: String,
        key: String,
    ) = "yaran-locked:v1:$namespace/$key".encodeToByteArray()

    companion object {
        /** Namespace names; they become file names, so this check is the path-traversal guard. */
        val NAMESPACE_RE = Regex("[a-z0-9-]{1,32}")
        val KEY_RE = Regex("[A-Za-z0-9._-]{1,64}")

        private const val BLOB_SUFFIX = ".bin"
        private const val DATA_KEY_FILE = "locked.key"
        private val DATA_KEY_AAD = "yaran-locked-key:v1".encodeToByteArray()
        private const val WRAP_STANDARD: Byte = 0
        private const val WRAP_LOCK: Byte = 1
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
        private const val KEY_BYTES = 32

        @Volatile private var instance: Vault? = null

        /** The process-wide vault in `noBackupFilesDir/vault`, backed by AndroidKeyStore. */
        fun shared(context: Context): Vault =
            instance ?: synchronized(this) {
                instance ?: Vault(File(context.noBackupFilesDir, "vault"), AndroidKeyStoreKeyProvider(context.applicationContext))
                    .also { instance = it }
            }

        private fun checkNames(
            namespace: String,
            key: String?,
        ) {
            if (!NAMESPACE_RE.matches(namespace)) throw CoreError.InvalidArgument("namespace must match ${NAMESPACE_RE.pattern}")
            if (key != null && !KEY_RE.matches(key)) throw CoreError.InvalidArgument("key must match ${KEY_RE.pattern}")
        }
    }
}
