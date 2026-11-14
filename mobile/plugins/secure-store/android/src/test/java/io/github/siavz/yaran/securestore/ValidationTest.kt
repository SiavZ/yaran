/**
 * ValidationTest: the secure-store adapters' argument checks and reserved-namespace refusal.
 *
 * Plain JUnit over the pure [Validation] object every adapter calls first, so each rejected
 * argument is pinned to the stable code the shell sees.
 *
 * - Reserved namespaces are refused by prefix, as `definitions.ts` documents.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.ValidationTest
 * ├── io.github.siavz.yaran.core.AppLock
 * ├── io.github.siavz.yaran.core.Diagnostics
 * ├── io.github.siavz.yaran.core.Vault
 * └── io.github.siavz.yaran.securestore.Validation (inferred)
 * External: org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import io.github.siavz.yaran.core.Diagnostics
import io.github.siavz.yaran.core.LockGrace
import io.github.siavz.yaran.core.Protection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ValidationTest {
    private fun code(block: () -> Unit): String = assertThrows(ArgumentError::class.java) { block() }.code

    @Test
    fun acceptsWellFormedNamespacesAndKeys() {
        assertEquals("orgs", Validation.namespace("orgs"))
        assertEquals("shell-prefs-2", Validation.namespace("shell-prefs-2"))
        assertEquals("Org_1.json-x", Validation.key("Org_1.json-x"))
    }

    @Test
    fun refusesReservedNamespacesByPrefix() {
        listOf("session", "sessions", "handoff", "handoff-x", "install", "installs", "push", "push-keys").forEach {
            assertEquals(it, "reserved_namespace", code { Validation.namespace(it) })
        }
        // Only a leading match is reserved: these merely contain a reserved word.
        assertEquals("my-session", Validation.namespace("my-session"))
        assertEquals("org-push", Validation.namespace("org-push"))
    }

    @Test
    fun refusesMalformedArguments() {
        listOf(null, "", "Orgs", "a/b", "../x", "a".repeat(33), "a b").forEach {
            assertEquals("$it", "invalid_argument", code { Validation.namespace(it) })
        }
        listOf(null, "", "a b", "a/b", "k".repeat(65)).forEach {
            assertEquals("$it", "invalid_argument", code { Validation.key(it) })
        }
        assertEquals("invalid_argument", code { Validation.value(null) })
        assertEquals("invalid_argument", code { Validation.protection("secret") })
        assertEquals("invalid_argument", code { Validation.grace("2min") })
        assertEquals("invalid_argument", code { Validation.flag(null, "enabled") })
        assertEquals("invalid_argument", code { Validation.level("debug") })
        assertEquals("invalid_argument", code { Validation.message(null) })
    }

    @Test
    fun parsesOptionalAndEnumeratedArguments() {
        assertEquals(Protection.STANDARD, Validation.protection(null))
        assertEquals(Protection.LOCKED, Validation.protection("locked"))
        assertNull(Validation.grace(null))
        assertEquals(LockGrace.FIVE_MINUTES, Validation.grace("5min"))
        assertEquals(Diagnostics.Level.ERROR, Validation.level("error"))
        assertEquals("", Validation.value(""))
    }
}
