/**
 * Test support: reads 02's shared fixtures and schemas from `cloud/protocol` (the Gradle test
 * task passes the path as `yaran.protocol`), so this suite pins the same vectors as every other.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.util, java.io, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.Fixtures
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPayloadParserTest (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayFcmTest
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object Fixtures {
    private val root = File(System.getProperty("yaran.protocol") ?: error("yaran.protocol is not set; run through Gradle"))

    fun json(path: String): JSONObject = JSONObject(File(root, path).readText())

    fun b64(text: String): ByteArray = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

    fun objects(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }

    /** The `required` and `properties` names of one schema definition. */
    fun schemaFields(file: String, def: String): Pair<Set<String>, Set<String>> {
        val d = json("schemas/$file").getJSONObject("\$defs").getJSONObject(def)
        val required = d.getJSONArray("required").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        return required to d.getJSONObject("properties").keys().asSequence().toSet()
    }
}
