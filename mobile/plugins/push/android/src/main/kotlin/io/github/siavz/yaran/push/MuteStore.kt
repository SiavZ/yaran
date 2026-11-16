/**
 * The local mirror the presenter reads: each org's mutes (02's `mute_all`, `muted_until`,
 * `muted_machine_ids`) and the org and machine names notifications are worded with.
 *
 * - Plain `SharedPreferences`: nothing here is secret. The Worker's device record is the source
 *   of truth and already stops muted sends; this mirror covers the gap before a sync and a
 *   stale server, so the phone also stays quiet offline.
 * - Excluded from backup with the plugin's other stores (Phase 14's backup rules).
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content, java.text, java.util, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.MuteStore
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * └── io.github.siavz.yaran.push.PushPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

data class LocalMutes(
    val muteAll: Boolean = false,
    /** Epoch seconds, or null. */
    val mutedUntil: Long? = null,
    val mutedMachineIds: Set<String> = emptySet(),
) {
    /** 02: sent only when !mute_all && (muted_until == null || now >= muted_until) && machine not muted. */
    fun isMuted(machineId: String, nowSeconds: Long): Boolean =
        muteAll || (mutedUntil != null && nowSeconds < mutedUntil) || machineId in mutedMachineIds

    companion object {
        /** From the bridge's `PushMutes` (`muted_until` is a 02 Timestamp). */
        fun fromJson(json: JSONObject?): LocalMutes {
            if (json == null) return LocalMutes()
            val until = json.optString("muted_until").takeIf { it.isNotEmpty() && it != "null" }
            val ids = json.optJSONArray("muted_machine_ids") ?: JSONArray()
            return LocalMutes(
                muteAll = json.optBoolean("mute_all", false),
                mutedUntil = until?.let(::timestampSeconds),
                mutedMachineIds = (0 until ids.length()).map { ids.getString(it) }.toSet(),
            )
        }
    }
}

/** 02 `Timestamp` (`YYYY-MM-DDTHH:MM:SSZ`) to epoch seconds; java.time needs API 26 and minSdk is 24. */
fun timestampSeconds(text: String): Long? = runCatching {
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
        timeZone = TimeZone.getTimeZone("UTC")
        isLenient = false
    }.parse(text)?.time?.div(1000)
}.getOrNull()

data class OrgDirectory(val orgName: String, val machines: Map<String, String>)

class MuteStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun mutes(orgId: String): LocalMutes {
        val raw = prefs.getString("mutes.$orgId", null) ?: return LocalMutes()
        val obj = JSONObject(raw)
        val ids = obj.getJSONArray("ids")
        return LocalMutes(
            muteAll = obj.getBoolean("all"),
            mutedUntil = if (obj.isNull("until")) null else obj.getLong("until"),
            mutedMachineIds = (0 until ids.length()).map { ids.getString(it) }.toSet(),
        )
    }

    fun setMutes(orgId: String, mutes: LocalMutes) {
        val obj = JSONObject()
            .put("all", mutes.muteAll)
            .put("until", mutes.mutedUntil ?: JSONObject.NULL)
            .put("ids", JSONArray(mutes.mutedMachineIds.toList()))
        prefs.edit().putString("mutes.$orgId", obj.toString()).apply()
    }

    fun directory(orgId: String): OrgDirectory? {
        val raw = prefs.getString("dir.$orgId", null) ?: return null
        val obj = JSONObject(raw)
        val machines = obj.getJSONObject("machines")
        return OrgDirectory(obj.getString("name"), machines.keys().asSequence().associateWith { machines.getString(it) })
    }

    fun setDirectory(orgId: String, directory: OrgDirectory) {
        val obj = JSONObject().put("name", directory.orgName).put("machines", JSONObject(directory.machines))
        prefs.edit().putString("dir.$orgId", obj.toString()).apply()
    }

    fun forget(orgId: String) {
        prefs.edit().remove("mutes.$orgId").remove("dir.$orgId").apply()
    }

    companion object {
        const val PREFS = "yaran_push_local"
    }
}
