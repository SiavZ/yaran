/**
 * HostRules: validates and canonicalises org URLs and machine hostnames typed or scanned by the user.
 *
 * An org URL becomes the Phase 02 `OrgUrl` form (`https://<lowercase host>`, no port, path,
 * query, fragment or trailing slash); a machine hostname becomes the 02 `Hostname` form. Every
 * refusal carries a stable code the shell turns into a sentence. The check order is fixed so
 * the Kotlin, Swift and TypeScript suites agree on `fixtures/host-rules-cases.json`.
 *
 * - Pure and thread-safe.
 * - HTTPS only; userinfo, IP literals, ports other than 443 and single-label hosts refused.
 * - shortcut: every IDN (any non-ASCII character or `xn--` label) is refused outright instead
 *   of detecting mixed scripts; upgrade if a real org needs an IDN domain.
 *
 * <module-headers:begin>
 * Uses: none
 * External: java.util
 *
 * Used by:
 * io.github.siavz.yaran.core.HostRules
 * └── io.github.siavz.yaran.core.FixturesTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import java.util.Locale

object HostRules {
    /** The outcome of a check: the canonical value, or a refusal with a stable code. */
    sealed class Result {
        data class Ok(
            val value: String,
        ) : Result()

        data class Refused(
            val code: String,
        ) : Result()
    }

    private val label = Regex("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?")
    private val tld = Regex("[a-z]{2,63}")
    private const val SCHEME = "https://"
    private const val MAX_HOST_LENGTH = 253
    private const val MAX_ASCII = 0x7F

    /** Validates an org URL and returns its canonical `https://<host>` form. */
    fun orgUrl(input: String): Result {
        val text = input.trim()
        if (text.isEmpty()) return Result.Refused("empty")
        if (!text.startsWith(SCHEME, ignoreCase = true)) return Result.Refused("not_https")
        val rest = text.substring(SCHEME.length)
        val end = rest.indexOfFirst { it == '/' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
        val authority = rest.substring(0, end)
        val remainder = rest.substring(end)
        if ('@' in authority) return Result.Refused("userinfo")
        if (authority.startsWith("[")) return Result.Refused("ip_literal")
        val colon = authority.lastIndexOf(':')
        val rawHost = if (colon < 0) authority else authority.substring(0, colon)
        if (colon >= 0 && authority.substring(colon + 1) != "443") return Result.Refused("port")
        if (rawHost.isEmpty()) return Result.Refused("invalid")
        checkHost(rawHost)?.let { return it }
        val path = remainder.substringBefore('?').substringBefore('#')
        if (path.isNotEmpty() && path != "/") return Result.Refused("path")
        if ('?' in remainder) return Result.Refused("query")
        if ('#' in remainder) return Result.Refused("fragment")
        return Result.Ok(SCHEME + rawHost.lowercase(Locale.ROOT))
    }

    /** Validates a bare machine hostname and returns it lowercased. */
    fun host(input: String): Result {
        val text = input.trim()
        if (text.isEmpty()) return Result.Refused("empty")
        if (text.startsWith("[")) return Result.Refused("ip_literal")
        if ('@' in text) return Result.Refused("userinfo")
        if ('/' in text || ':' in text) return Result.Refused("invalid")
        checkHost(text)?.let { return it }
        return Result.Ok(text.lowercase(Locale.ROOT))
    }

    /** The host checks both entry points share; null when the host is acceptable. */
    private fun checkHost(rawHost: String): Result.Refused? {
        if (rawHost.any { it.code > MAX_ASCII }) return Result.Refused("idn")
        val host = rawHost.lowercase(Locale.ROOT)
        val labels = host.split('.')
        if (labels.any { it.startsWith("xn--") }) return Result.Refused("idn")
        if (labels.all { part -> part.isNotEmpty() && part.all { it in '0'..'9' } }) return Result.Refused("ip_literal")
        val wellFormed =
            labels.size >= 2 &&
                host.length <= MAX_HOST_LENGTH &&
                labels.all { label.matches(it) } &&
                tld.matches(labels.last())
        return if (wellFormed) null else Result.Refused("invalid")
    }
}
