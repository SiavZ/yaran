/**
 * The decrypted push payload v1 (02 §9), parsed strictly on the device, plus 02's topic and the
 * display sanitizer.
 *
 * Mirrors `@yaran/protocol`'s `parsePushPayload` and the Swift core: at most 320 bytes, valid
 * UTF-8 JSON, `v` 1, a known `k` (an unknown kind is 02's `push_payload_invalid`, pinned by the
 * fixture), `test` carrying only `v`/`k`/`ts`, the id patterns, `s` kept as a token, and `p`/`l`
 * at most 24 UTF-8 bytes. `pushTopic` is 02's `topic(m, a, t)`, the notification tag.
 *
 * - Trust boundary: the payload is authenticated only as "holds the org's VAPID key and this
 *   device's auth secret"; anything off-shape returns null and the generic text stays.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.util, java.nio, java.nio.charset, java.security, org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.PushPayloadParser
 * ├── io.github.siavz.yaran.push.NotificationPresenter (inferred)
 * ├── io.github.siavz.yaran.push.NotificationPresenterTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPayloadParserTest (inferred)
 * ├── io.github.siavz.yaran.push.YaranPushService (inferred)
 * └── io.github.siavz.yaran.push.relay.RelayFcmTransport
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import android.util.Base64
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

/** One agent-scoped push; `token` is the RowState token or the ending token. */
data class AgentPush(
    val machineId: String,
    val agentId: String,
    val tabId: String?,
    val token: String,
    val project: String?,
    val label: String?,
)

sealed class PushPayload {
    abstract val ts: Long

    data class AttentionRaised(val push: AgentPush, override val ts: Long) : PushPayload()
    data class AttentionCleared(val push: AgentPush, override val ts: Long) : PushPayload()
    data class AgentExitedBadly(val push: AgentPush, override val ts: Long) : PushPayload()
    data class Test(override val ts: Long) : PushPayload()

    val agent: AgentPush?
        get() = when (this) {
            is AttentionRaised -> push
            is AttentionCleared -> push
            is AgentExitedBadly -> push
            is Test -> null
        }

    val kind: String
        get() = when (this) {
            is AttentionRaised -> "attention_raised"
            is AttentionCleared -> "attention_cleared"
            is AgentExitedBadly -> "agent_exited_badly"
            is Test -> "test"
        }
}

object PushPayloadParser {
    const val MAX_BYTES = 320
    const val MAX_TEXT_BYTES = 24

    private val UUID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    private val YARAN_ID = Regex("[\\x21-\\x7e]{1,128}")
    private val TOKEN = Regex("[a-z_]{1,32}")

    /** Null is 02's `push_payload_invalid`. */
    fun parse(bytes: ByteArray): PushPayload? {
        if (bytes.size > MAX_BYTES) return null
        val text = strictUtf8(bytes) ?: return null
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return null
        if (integer(obj.opt("v")) != 1L) return null
        val ts = integer(obj.opt("ts"))?.takeIf { it >= 0 } ?: return null
        return when (obj.opt("k")) {
            "test" -> if (obj.keys().asSequence().all { it in setOf("v", "k", "ts") }) PushPayload.Test(ts) else null
            "attention_raised" -> agent(obj)?.let { PushPayload.AttentionRaised(it, ts) }
            "attention_cleared" -> agent(obj)?.let { PushPayload.AttentionCleared(it, ts) }
            "agent_exited_badly" -> agent(obj)?.let { PushPayload.AgentExitedBadly(it, ts) }
            else -> null
        }
    }

    private fun agent(obj: JSONObject): AgentPush? {
        val m = (obj.opt("m") as? String)?.takeIf { UUID.matches(it) } ?: return null
        val a = (obj.opt("a") as? String)?.takeIf { YARAN_ID.matches(it) } ?: return null
        val s = (obj.opt("s") as? String)?.takeIf { TOKEN.matches(it) } ?: return null
        val t = if (obj.has("t")) (obj.opt("t") as? String)?.takeIf { YARAN_ID.matches(it) } ?: return null else null
        val p = text(obj, "p") ?: return null
        val l = text(obj, "l") ?: return null
        return AgentPush(m, a, t, s, p.value, l.value)
    }

    /** Optional `p`/`l`: the outer null means present but invalid. */
    private fun text(obj: JSONObject, key: String): Box? {
        if (!obj.has(key)) return Box(null)
        val value = obj.opt(key) as? String ?: return null
        return if (value.isNotEmpty() && value.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_BYTES) Box(value) else null
    }

    private class Box(val value: String?)

    private fun integer(value: Any?): Long? = when (value) {
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }

    private fun strictUtf8(bytes: ByteArray): String? = try {
        Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes)).toString()
    } catch (_: CharacterCodingException) {
        null
    }
}

/** 02's `topic(m, a, t)`: the Android notification tag, one per agent tab. */
fun pushTopic(machineId: String, agentId: String, tabId: String?): String {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest("yaran-topic-v1\n$machineId\n$agentId\n${tabId.orEmpty()}".toByteArray(Charsets.UTF_8))
    return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP).take(32)
}

/** Strips C0/C1 controls and bidi overrides/isolates before anything is shown. */
fun displayText(text: String): String =
    text.filterNot { it.isISOControl() || it in BIDI_CONTROLS }.trim()

private val BIDI_CONTROLS = setOf(
    '؜', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩',
)
