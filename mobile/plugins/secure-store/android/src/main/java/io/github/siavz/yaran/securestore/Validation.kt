/**
 * Validation: the argument checks every secure-store adapter applies before it calls the core.
 *
 * The shell is trusted but still a WebView, so each bridge argument is checked here, in one
 * pure place the adapters and the JVM tests share (and the G6 fallback's handlers would reuse).
 * A failed check is an [ArgumentError] whose code is one of the `definitions.ts` codes.
 *
 * - Namespaces `[a-z0-9-]{1,32}`, keys `[A-Za-z0-9._-]{1,64}`, the same patterns as the core.
 * - Namespaces starting with `session`, `handoff`, `install` or `push` belong to native code
 *   (Phases 15 and 16) and are refused with `reserved_namespace`.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.Validation
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.core.Diagnostics
 * └── io.github.siavz.yaran.core.Vault
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.securestore.Validation
 * ├── io.github.siavz.yaran.securestore.AppLockPlugin (inferred)
 * ├── io.github.siavz.yaran.securestore.DiagnosticsPlugin (inferred)
 * ├── io.github.siavz.yaran.securestore.ScreenPrivacyPlugin (inferred)
 * ├── io.github.siavz.yaran.securestore.SecureStorePlugin (inferred)
 * └── io.github.siavz.yaran.securestore.ValidationTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import io.github.siavz.yaran.core.Diagnostics
import io.github.siavz.yaran.core.LockGrace
import io.github.siavz.yaran.core.Protection
import io.github.siavz.yaran.core.Vault

/** A rejected bridge argument; [code] is `invalid_argument` or `reserved_namespace`. */
class ArgumentError(
    val code: String,
    message: String,
) : Exception(message)

object Validation {
    val RESERVED_NAMESPACES = listOf("session", "handoff", "install", "push")

    fun namespace(value: String?): String {
        val namespace = required(value, "namespace")
        if (!Vault.NAMESPACE_RE.matches(namespace)) invalid("namespace must match ${Vault.NAMESPACE_RE.pattern}")
        RESERVED_NAMESPACES.firstOrNull(namespace::startsWith)?.let {
            throw ArgumentError("reserved_namespace", "the $it namespaces belong to native code")
        }
        return namespace
    }

    fun key(value: String?): String {
        val key = required(value, "key")
        if (!Vault.KEY_RE.matches(key)) invalid("key must match ${Vault.KEY_RE.pattern}")
        return key
    }

    fun value(value: String?): String = required(value, "value")

    /** Absent means `standard`. */
    fun protection(value: String?): Protection =
        if (value == null) Protection.STANDARD else Protection.parse(value) ?: invalid("protection must be standard or locked")

    /** Absent means "leave unchanged". */
    fun grace(value: String?): LockGrace? =
        value?.let { LockGrace.parse(it) ?: invalid("grace must be one of ${LockGrace.entries.joinToString { g -> g.code }}") }

    fun flag(
        value: Boolean?,
        name: String,
    ): Boolean = value ?: invalid("$name must be a boolean")

    fun level(value: String?): Diagnostics.Level =
        Diagnostics.Level.parse(required(value, "level")) ?: invalid("level must be info, warn or error")

    fun message(value: String?): String = required(value, "message")

    private fun required(
        value: String?,
        name: String,
    ): String = value ?: invalid("$name is required")

    private fun invalid(message: String): Nothing = throw ArgumentError("invalid_argument", message)
}
