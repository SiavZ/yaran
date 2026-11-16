/**
 * FixturesTest: runs the Kotlin sanitizer and host rules against the shared cross-platform fixtures.
 *
 * The fixture files in `mobile/plugins/core/fixtures/` are read by the Kotlin, Swift and
 * TypeScript suites; every case must pass on every platform. Gradle passes the directory in
 * the `yaran.fixtures` system property.
 *
 * - Iterates every case and reports all mismatches together, failing on any.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.FixturesTest
 * ├── io.github.siavz.yaran.core.HostRules (inferred)
 * └── io.github.siavz.yaran.core.Sanitizer (inferred)
 * External: java.io, org.json, org.junit, org.junit.Assert
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class FixturesTest {
    private fun fixture(name: String): JSONObject {
        val dir = System.getProperty("yaran.fixtures") ?: error("yaran.fixtures system property not set")
        return JSONObject(File(dir, name).readText())
    }

    @Test
    fun sanitizerMatchesEveryFixtureCase() {
        val cases = fixture("sanitizer-cases.json").getJSONArray("cases")
        assertTrue("fixture has cases", cases.length() > 0)
        val failures =
            (0 until cases.length()).map(cases::getJSONObject).mapNotNull { case ->
                val actual = Sanitizer.sanitize(case.getString("input"))
                if (actual == case.getString("expect")) null else "${case.getString("name")}: got ${actual.quoted()}"
            }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun hostRulesMatchEveryFixtureCase() {
        val root = fixture("host-rules-cases.json")
        val failures =
            listOf("orgUrl" to HostRules::orgUrl, "host" to HostRules::host).flatMap { (kind, check) ->
                val cases = root.getJSONArray(kind)
                assertTrue("$kind has cases", cases.length() > 0)
                (0 until cases.length()).map(cases::getJSONObject).mapNotNull { case ->
                    val expect = case.getJSONObject("expect")
                    val wanted =
                        if (expect.has(
                                "ok",
                            )
                        ) {
                            HostRules.Result.Ok(expect.getString("ok"))
                        } else {
                            HostRules.Result.Refused(expect.getString("refused"))
                        }
                    val actual = check(case.getString("input"))
                    if (actual == wanted) null else "$kind(${case.getString("input").quoted()}): want $wanted, got $actual"
                }
            }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    private fun String.quoted() = "\"" + replace("\u001B", "\\e") + "\""
}
