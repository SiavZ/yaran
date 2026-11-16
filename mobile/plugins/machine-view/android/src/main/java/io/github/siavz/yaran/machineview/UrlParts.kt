/**
 * The house URL splitter every policy twin uses, so Kotlin and Swift decide identically.
 *
 * Platform URL parsers disagree on hosts, escapes and odd schemes; this splitter is a few
 * regular expressions that both twins copy. It refuses any whitespace, control or non-ASCII
 * character outright, so a homograph or a smuggled newline never reaches a decision.
 *
 * - Pure. `authority` is null for opaque URIs (`mailto:`, `about:`), present for `scheme://`.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.UrlParts
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.ControlUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.NavigationPolicy (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.SealedEnvelope (inferred)
 * └── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal data class UrlParts(
    val scheme: String,
    val authority: String?,
    val path: String,
    val query: String?,
    val fragment: String?,
    /** Everything after `scheme:` (for opaque URIs such as `about:blank`). */
    val rest: String,
) {
    companion object {
        private val SCHEME = Regex("^([A-Za-z][A-Za-z0-9+.-]*):(.*)$")
        private val HIER = Regex("^//([^/?#]*)([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$")
        private val OPAQUE = Regex("^([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$")

        fun parse(url: String): UrlParts? {
            if (url.any { it.code <= 0x20 || it.code >= 0x7f }) return null
            val m = SCHEME.matchEntire(url) ?: return null
            val scheme = m.groupValues[1].lowercase()
            val rest = m.groupValues[2]
            val h = HIER.matchEntire(rest)
            if (h != null) {
                return UrlParts(scheme, h.groupValues[1], h.groupValues[2], h.groups[3]?.value, h.groups[4]?.value, rest)
            }
            val o = OPAQUE.matchEntire(rest) ?: return null
            return UrlParts(scheme, null, o.groupValues[1], o.groups[2]?.value, o.groups[3]?.value, rest)
        }
    }
}

internal object HostRules {
    val HOSTNAME = Regex("^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
    val ORG_URL = Regex("^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$")
    private val PORT = Regex("^[0-9]{1,5}$")

    /** Host (lowercased) and port of an authority, or null when it has userinfo or a bad shape. */
    fun hostPort(authority: String): Pair<String, String?>? {
        if ('@' in authority) return null
        val colon = authority.lastIndexOf(':')
        val host = (if (colon < 0) authority else authority.substring(0, colon)).lowercase()
        val port = if (colon < 0) null else authority.substring(colon + 1)
        if (port != null && !PORT.matches(port)) return null
        if (!HOSTNAME.matches(host)) return null
        return host to port
    }

    fun isDefaultHttpsPort(port: String?): Boolean = port == null || port.toInt() == 443
}
