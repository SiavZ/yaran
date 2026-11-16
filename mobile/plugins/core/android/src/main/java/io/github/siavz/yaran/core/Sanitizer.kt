/**
 * Sanitizer: strips secrets and terminal control sequences from text before it is logged.
 *
 * Every diagnostics entry passes through `sanitize` before it is kept in memory or written to
 * disk, so an exported log never carries a credential or a sequence that could drive the
 * reader's terminal. The rules and their order are shared with the iOS core and pinned by
 * `mobile/plugins/core/fixtures/sanitizer-cases.json`.
 *
 * - Pure and thread-safe: compiled patterns only, no state.
 * - Rule order matters: control sequences go first so a header split by colour codes is
 *   still recognised, and JWTs go before URL queries so a token in a query is redacted twice
 *   over rather than left half visible.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.core.Sanitizer
 * ├── io.github.siavz.yaran.core.Diagnostics (inferred)
 * └── io.github.siavz.yaran.core.FixturesTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

object Sanitizer {
    private val csi = Regex("\u001B\\[[0-?]*[ -/]*[@-~]")
    private val osc = Regex("\u001B\\][^\u0007\u001B]*(?:\u0007|\u001B\\\\)")
    private val twoByteEscape = Regex("\u001B[\\s\\S]?")
    private val c0 = Regex("[\u0000-\u0008\u000B-\u001F]")
    private val header = Regex("(?i)\\b(Set-Cookie|Cookie|Authorization):[^\n]*")
    private val jwt = Regex("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*")
    private val url = Regex("[A-Za-z][A-Za-z0-9+.-]*://\\S*")

    /** Returns [input] with control sequences removed and secrets redacted. */
    fun sanitize(input: String): String {
        val plain =
            input
                .replace(csi, "")
                .replace(osc, "")
                .replace(twoByteEscape, "")
                .replace(c0, "")
        return plain
            .replace(header) { "${it.groupValues[1]}: [redacted]" }
            .replace(jwt, "[jwt]")
            .replace(url) { match -> match.value.substringBefore('?').substringBefore('#') }
    }
}
