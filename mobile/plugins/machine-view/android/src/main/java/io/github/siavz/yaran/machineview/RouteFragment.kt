/**
 * Validates the agent route `MachineView.open` may load: `#/agent/<seg>[/tab/<seg>]`.
 *
 * The restricted `store.ts` parseRoute grammar (Phase 15 Design). A raw segment is
 * `[A-Za-z0-9-_.!~*'()]` or `%XX`; decoded it must be 1-128 printable ASCII bytes (YaranId).
 * Pinned by `fixtures/routes.json`, shared with the TypeScript and Swift twins.
 *
 * - Pure. A route is appended to `https://<host>/` only after it passes.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.RouteFragment
 * ├── io.github.siavz.yaran.machineview.MachineState (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal object RouteFragment {
    private const val SEG = "((?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-Fa-f]{2})+)"
    private val ROUTE = Regex("^#/agent/$SEG(?:/tab/$SEG)?$")

    fun isValid(route: String): Boolean {
        val m = ROUTE.matchEntire(route) ?: return false
        return segmentOk(m.groupValues[1]) && (m.groups[2] == null || segmentOk(m.groupValues[2]))
    }

    private fun segmentOk(raw: String): Boolean {
        var count = 0
        var i = 0
        while (i < raw.length) {
            val b = if (raw[i] == '%') raw.substring(i + 1, i + 3).toInt(16).also { i += 3 } else raw[i++].code
            if (b < 0x20 || b > 0x7e) return false
            count++
        }
        return count in 1..128
    }
}
