/**
 * AppLock: the optional biometric lock over the vault's `locked` class and the shell.
 *
 * Enabling creates an auth-per-use keystore key and proves the user can unlock by sealing the
 * vault's data key under it inside a `BiometricPrompt` with a `CryptoObject`; unlocking opens
 * it the same way, so the lock is enforced by the keystore, never by a bare prompt result. A
 * biometric change invalidates the key: the locked class is wiped and the caller is told.
 *
 * - `BIOMETRIC_STRONG`, or `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` on API 30+ when the user
 *   allows the device passcode (older releases cannot pair a credential with a CryptoObject).
 * - The grace period runs from going to the background, on the monotonic clock; the pure
 *   [shouldLock] decides. A cold start is always locked when the lock is enabled.
 * - Whether the lock is enabled is derived from the vault; grace and passcode fallback are
 *   persisted options. Listeners hear every lock-state change (main thread or caller thread).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.AppLock
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: android.content, android.os, androidx.biometric, androidx.biometric.BiometricManager.Authenticators, androidx.core.content, androidx.fragment.app, java.util.concurrent, javax.crypto
 *
 * Used by:
 * io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.app.MainActivity
 * ├── io.github.siavz.yaran.core.AppLockPolicyTest (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdapters
 * ├── io.github.siavz.yaran.securestore.AppLockPlugin
 * ├── io.github.siavz.yaran.securestore.SecureStorePlugin
 * ├── io.github.siavz.yaran.securestore.Validation
 * └── io.github.siavz.yaran.securestore.ValidationTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.content.Context
import android.os.Build
import android.os.SystemClock
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.util.concurrent.CopyOnWriteArraySet
import javax.crypto.Cipher

/** How long the app may sit in the background before the lock engages again. */
enum class LockGrace(
    val code: String,
    val millis: Long,
) {
    IMMEDIATELY("immediately", 0),
    ONE_MINUTE("1min", 60_000),
    FIVE_MINUTES("5min", 300_000),
    FIFTEEN_MINUTES("15min", 900_000),
    ;

    companion object {
        val DEFAULT = ONE_MINUTE

        fun parse(code: String): LockGrace? = entries.firstOrNull { it.code == code }
    }
}

enum class Biometry(
    val code: String,
) {
    AVAILABLE("available"),
    NONE_ENROLLED("none_enrolled"),
    UNAVAILABLE("unavailable"),
}

enum class EnableOutcome(
    val code: String,
) {
    ENABLED("enabled"),
    CANCELLED("cancelled"),
    UNAVAILABLE("unavailable"),
}

enum class DisableOutcome(
    val code: String,
) {
    DISABLED("disabled"),
    CANCELLED("cancelled"),
}

enum class UnlockOutcome(
    val code: String,
) {
    UNLOCKED("unlocked"),
    CANCELLED("cancelled"),
    INVALIDATED("invalidated"),
}

class AppLock private constructor(
    context: Context,
    private val vault: Vault,
) {
    data class Status(
        val enabled: Boolean,
        val allowPasscode: Boolean,
        val grace: LockGrace,
        val locked: Boolean,
        val biometry: Biometry,
    )

    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val listeners = CopyOnWriteArraySet<(Boolean) -> Unit>()
    private var backgroundedAt: Long? = null

    @Volatile
    var locked: Boolean = vault.isLockWrapped()
        private set

    fun status(): Status =
        Status(
            enabled = vault.isLockWrapped(),
            allowPasscode = prefs.getBoolean(KEY_PASSCODE, false),
            grace = grace(),
            locked = locked,
            biometry =
                when (BiometricManager.from(appContext).canAuthenticate(BIOMETRIC_STRONG)) {
                    BiometricManager.BIOMETRIC_SUCCESS -> Biometry.AVAILABLE
                    BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> Biometry.NONE_ENROLLED
                    else -> Biometry.UNAVAILABLE
                },
        )

    /**
     * Updates the persisted options. Passcode fallback is fixed in the lock key when it is
     * created, so changing it while the lock is on is refused: disable and enable again.
     */
    fun setOptions(
        grace: LockGrace?,
        allowPasscode: Boolean?,
    ) {
        if (allowPasscode != null && vault.isLockWrapped() && allowPasscode != prefs.getBoolean(KEY_PASSCODE, false)) {
            throw CoreError.InvalidArgument("turn the app lock off and on again to change the passcode fallback")
        }
        prefs
            .edit()
            .apply {
                grace?.let { putString(KEY_GRACE, it.code) }
                allowPasscode?.let { putBoolean(KEY_PASSCODE, it) }
            }.apply()
    }

    fun addListener(listener: (Boolean) -> Unit) = listeners.add(listener)

    fun removeListener(listener: (Boolean) -> Unit) = listeners.remove(listener)

    /** Records the moment the app went to the background. */
    fun onBackground(nowMs: Long = SystemClock.elapsedRealtime()) {
        backgroundedAt = nowMs
    }

    /** Engages the lock when the grace period ran out; returns whether the app is locked. */
    fun onForeground(nowMs: Long = SystemClock.elapsedRealtime()): Boolean {
        val since = backgroundedAt
        backgroundedAt = null
        if (!locked && since != null && vault.isLockWrapped() && shouldLock(since, nowMs, grace())) {
            vault.relock()
            setLocked(true)
        }
        return locked
    }

    fun enable(
        activity: FragmentActivity,
        allowPasscode: Boolean,
        done: (Result<EnableOutcome>) -> Unit,
    ) {
        if (vault.isLockWrapped()) return done(Result.success(EnableOutcome.ENABLED))
        val authenticators = authenticators(allowPasscode)
        if (BiometricManager.from(appContext).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            return done(Result.success(EnableOutcome.UNAVAILABLE))
        }
        val cipher =
            try {
                vault.lockCipherForEnable(allowPasscode)
            } catch (_: CoreError) {
                return done(Result.success(EnableOutcome.UNAVAILABLE))
            }
        prompt(activity, cipher, authenticators, R.string.yaran_applock_enable_title) { authenticated ->
            if (authenticated == null) {
                vault.deleteLockKey()
                done(Result.success(EnableOutcome.CANCELLED))
            } else {
                done(
                    runCatching {
                        vault.wrapUnderLock(authenticated)
                        prefs.edit().putBoolean(KEY_PASSCODE, allowPasscode).apply()
                        setLocked(false)
                        EnableOutcome.ENABLED
                    },
                )
            }
        }
    }

    fun disable(
        activity: FragmentActivity,
        done: (Result<DisableOutcome>) -> Unit,
    ) {
        if (!vault.isLockWrapped()) return done(Result.success(DisableOutcome.DISABLED))
        val cipher =
            try {
                vault.lockCipherForUnlock()
            } catch (_: CoreError.Invalidated) {
                setLocked(false)
                return done(Result.success(DisableOutcome.DISABLED))
            } catch (e: CoreError) {
                return done(Result.failure(e))
            }
        prompt(activity, cipher, currentAuthenticators(), R.string.yaran_applock_disable_title) { authenticated ->
            if (authenticated == null) return@prompt done(Result.success(DisableOutcome.CANCELLED))
            done(
                runCatching {
                    vault.unlock(authenticated)
                    vault.wrapUnderStandard()
                    vault.deleteLockKey()
                    setLocked(false)
                    DisableOutcome.DISABLED
                },
            )
        }
    }

    fun unlock(
        activity: FragmentActivity,
        done: (Result<UnlockOutcome>) -> Unit,
    ) {
        if (!vault.isLockWrapped() || vault.isUnlocked()) {
            setLocked(false)
            return done(Result.success(UnlockOutcome.UNLOCKED))
        }
        val cipher =
            try {
                vault.lockCipherForUnlock()
            } catch (_: CoreError.Invalidated) {
                setLocked(false)
                return done(Result.success(UnlockOutcome.INVALIDATED))
            } catch (e: CoreError) {
                return done(Result.failure(e))
            }
        prompt(activity, cipher, currentAuthenticators(), R.string.yaran_applock_unlock_title) { authenticated ->
            if (authenticated == null) return@prompt done(Result.success(UnlockOutcome.CANCELLED))
            done(
                runCatching {
                    vault.unlock(authenticated)
                    setLocked(false)
                    UnlockOutcome.UNLOCKED
                },
            )
        }
    }

    /** Called after the vault was erased: the lock is off and nothing is hidden any more. */
    fun onVaultErased() {
        prefs.edit().remove(KEY_PASSCODE).apply()
        setLocked(false)
    }

    private fun grace(): LockGrace = prefs.getString(KEY_GRACE, null)?.let(LockGrace::parse) ?: LockGrace.DEFAULT

    private fun currentAuthenticators() = authenticators(prefs.getBoolean(KEY_PASSCODE, false))

    private fun setLocked(value: Boolean) {
        if (locked == value) return
        locked = value
        listeners.forEach { it(value) }
    }

    /** Shows the prompt on the main thread; [done] gets the authenticated cipher, or null on cancel or error. */
    private fun prompt(
        activity: FragmentActivity,
        cipher: Cipher,
        authenticators: Int,
        title: Int,
        done: (Cipher?) -> Unit,
    ) {
        activity.runOnUiThread {
            val info =
                BiometricPrompt.PromptInfo
                    .Builder()
                    .setTitle(activity.getString(title))
                    .setSubtitle(activity.getString(R.string.yaran_applock_subtitle))
                    .setAllowedAuthenticators(authenticators)
                    .apply {
                        if (authenticators and DEVICE_CREDENTIAL ==
                            0
                        ) {
                            setNegativeButtonText(activity.getString(R.string.yaran_applock_cancel))
                        }
                    }.build()
            val callback =
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = done(result.cryptoObject?.cipher)

                    override fun onAuthenticationError(
                        errorCode: Int,
                        errString: CharSequence,
                    ) = done(null)
                }
            BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                callback,
            ).authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }

    companion object {
        private const val PREFS = "yaran.applock"
        private const val KEY_GRACE = "grace"
        private const val KEY_PASSCODE = "allowPasscode"

        @Volatile private var instance: AppLock? = null

        fun shared(context: Context): AppLock =
            instance ?: synchronized(this) {
                instance ?: AppLock(context, Vault.shared(context)).also { instance = it }
            }

        /** True when an app backgrounded at [backgroundedAtMs] must lock at [nowMs]; a clock that went backwards locks. */
        fun shouldLock(
            backgroundedAtMs: Long,
            nowMs: Long,
            grace: LockGrace,
        ): Boolean = nowMs < backgroundedAtMs || nowMs - backgroundedAtMs >= grace.millis

        private fun authenticators(allowPasscode: Boolean): Int =
            if (allowPasscode && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) BIOMETRIC_STRONG or DEVICE_CREDENTIAL else BIOMETRIC_STRONG
    }
}
