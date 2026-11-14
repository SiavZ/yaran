/**
 * DiagnosticsTest: the ring log's sanitizing, persistence and caps.
 *
 * Uses a temporary file and an injected clock, so the seven-day and 1 MiB limits are checked
 * without waiting or writing a megabyte by hand more than once.
 *
 * - Entries are sanitized before they are kept, in memory and on disk.
 * - A new instance over the same file reads the same log, multi-line messages included.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.DiagnosticsTest
 * └── io.github.siavz.yaran.core.Diagnostics (inferred)
 * External: org.junit, org.junit.Assert, org.junit.rules
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class DiagnosticsTest {
    @get:Rule val temp = TemporaryFolder()

    private var now = 1_700_000_000_000L

    @Test
    fun sanitizesAndPersists() {
        val file = temp.root.resolve("diag.log")
        val log = Diagnostics(file) { now }
        log.append(Diagnostics.Level.WARN, "GET https://cp.example.com/v1?state=abc\nAuthorization: Bearer x")
        val text = log.read()
        assertTrue(text, text.endsWith("WARN GET https://cp.example.com/v1\n  Authorization: [redacted]\n"))
        assertFalse(file.readText().contains("state=abc"))
        assertEquals(text, Diagnostics(file) { now }.read())
    }

    @Test
    fun dropsEntriesOlderThanSevenDays() {
        val log = Diagnostics(temp.root.resolve("diag.log")) { now }
        log.append(Diagnostics.Level.INFO, "old")
        now += Diagnostics.MAX_AGE_MS + 1
        log.append(Diagnostics.Level.INFO, "new")
        val text = log.read()
        assertFalse(text.contains("old"))
        assertTrue(text.contains("new"))
    }

    @Test
    fun staysUnderOneMebibyte() {
        val file = temp.root.resolve("diag.log")
        val log = Diagnostics(file) { now }
        repeat(200) { log.append(Diagnostics.Level.INFO, "entry $it " + "x".repeat(8000)) }
        assertTrue(log.read().encodeToByteArray().size <= Diagnostics.MAX_BYTES)
        assertTrue(file.length() <= Diagnostics.MAX_BYTES)
        assertTrue(log.read().contains("entry 199 "))
        assertFalse(log.read().contains("entry 0 "))
    }
}
