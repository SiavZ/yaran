/**
 * Test helper that loads the shared fixture tables both native suites read.
 *
 * Paths come from Gradle system properties: the plugin's own `fixtures/` and the Phase 02
 * `cloud/protocol` package, so the bytes are exactly the ones the Swift suite reads.
 *
 * - Test only; uses the real org.json on the JVM test classpath.
 *
 * <module-headers:begin>
 * Uses: none
 * External: java.io, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.Fixtures
 * ├── io.github.siavz.yaran.machineview.CryptoFixtureTest
 * ├── io.github.siavz.yaran.machineview.HandoffUrlFixtureTest
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object Fixtures {
    private fun dir(prop: String) = File(System.getProperty(prop) ?: error("system property $prop is not set"))

    fun plugin(name: String) = JSONObject(File(dir("machineview.fixtures"), name).readText())

    fun protocol(path: String) = JSONObject(File(dir("machineview.protocol"), path).readText())

    fun protocolDir(path: String) = File(dir("machineview.protocol"), path)

    fun cases(o: JSONObject, key: String = "cases"): List<JSONObject> = o.getJSONArray(key).objects()

    fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key) || !has(key)) null else getString(key)

    fun JSONObject.optLongOrNull(key: String): Long? = if (isNull(key) || !has(key)) null else getLong(key)

    fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
