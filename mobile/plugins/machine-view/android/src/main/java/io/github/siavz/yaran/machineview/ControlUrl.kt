/**
 * `yaranapp://` parsing (02 §10) and the machine window's decision for a control URL.
 *
 * A port of `@yaran/protocol` `parseUri`, `parseAppUri` and `controlUrlDecision`, pinned by
 * `cloud/protocol/fixtures/uri/control-urls.json`. The three in-WebView control URLs
 * (reauth for the loaded host, home, settings) never leave the machine window: the
 * navigation policy cancels them before navigation and acts on this decision.
 *
 * - Pure. Parameters are percent-decoded like `decodeURIComponent` (strict UTF-8, no `+`).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.ControlUrl
 * └── io.github.siavz.yaran.machineview.UrlParts (inferred)
 * External: java.nio, java.nio.charset
 *
 * Used by:
 * io.github.siavz.yaran.machineview.ControlUrl
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

internal data class ParsedUri(
    val scheme: String,
    val command: String,
    val query: Map<String, String>,
    val fragment: Map<String, String>,
)

internal object UriParams {
    private val URI = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(/[^?#]*)?(?:\\?([^#]*))?(?:#(.*))?$")

    fun parseUri(uri: String): ParsedUri? {
        val m = URI.matchEntire(uri) ?: return null
        val query = params(m.groups[4]?.value) ?: return null
        val fragment = params(m.groups[5]?.value) ?: return null
        return ParsedUri(m.groupValues[1].lowercase(), m.groupValues[2] + (m.groups[3]?.value ?: ""), query, fragment)
    }

    /** `a=b&c=d`, decoded; null on a duplicate key or a bad escape. */
    fun params(text: String?): Map<String, String>? {
        val out = LinkedHashMap<String, String>()
        if (text.isNullOrEmpty()) return out
        for (pair in text.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = decode(if (eq < 0) pair else pair.substring(0, eq)) ?: return null
            val value = decode(if (eq < 0) "" else pair.substring(eq + 1)) ?: return null
            if (out.containsKey(key)) return null
            out[key] = value
        }
        return out
    }

    /** `decodeURIComponent`: %XX sequences must form valid UTF-8; other characters pass through. */
    fun decode(s: String): String? {
        if ('%' !in s) return s
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '%') {
                if (i + 2 >= s.length) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0) return null
                bytes.write(hi * 16 + lo)
                i += 3
            } else {
                bytes.write(c.toString().toByteArray(Charsets.UTF_8))
                i++
            }
        }
        return try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (e: CharacterCodingException) {
            null
        }
    }
}

internal sealed interface ControlDecision {
    data object Reauth : ControlDecision
    data object Home : ControlDecision
    data object Settings : ControlDecision

    /** Ignored; [invalid] is true when the URI itself was `uri_invalid` (not merely another host). */
    data class Ignore(val invalid: Boolean) : ControlDecision
}

internal object ControlUrl {
    private const val MAX_CHARS = 512

    fun decide(uri: String, loadedHost: String): ControlDecision {
        val invalid = ControlDecision.Ignore(invalid = true)
        if (uri.length > MAX_CHARS) return invalid
        val p = UriParams.parseUri(uri) ?: return invalid
        if (p.scheme != "yaranapp") return invalid
        return when (p.command) {
            "reauth" -> {
                val host = p.query["host"]
                when {
                    host == null || !HostRules.HOSTNAME.matches(host) -> invalid
                    host == loadedHost -> ControlDecision.Reauth
                    else -> ControlDecision.Ignore(invalid = false)
                }
            }
            "home" -> ControlDecision.Home
            "settings" -> ControlDecision.Settings
            "add-org" -> ControlDecision.Ignore(invalid = p.query["u"]?.let { HostRules.ORG_URL.matches(it) } != true)
            else -> invalid
        }
    }
}
