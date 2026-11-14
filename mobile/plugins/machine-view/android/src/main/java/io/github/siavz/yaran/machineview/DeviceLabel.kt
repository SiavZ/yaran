/**
 * The device label sent as `HandoffQuery.device` and `DeviceRegistration.label`.
 *
 * The OS device name, else the model, with control and bidi characters removed (the consent
 * page shows it, and a bidi override could make it lie), trimmed and cut to 64 code points.
 * Pinned by `fixtures/device-labels.json`, shared with Swift and with Phase 16.
 *
 * - Pure; counts code points, never UTF-16 units, so a surrogate pair is never split.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.DeviceLabel
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

object DeviceLabel {
    const val FALLBACK = "Phone"
    private const val MAX = 64

    fun clean(name: String?, model: String): String =
        tidy(name ?: "").ifEmpty { tidy(model) }.ifEmpty { FALLBACK }

    private fun tidy(s: String): String {
        val kept = s.codePoints().filter { !isRemoved(it) }.toArray()
        val trimmed = String(kept, 0, kept.size).trim(' ')
        val cps = trimmed.codePoints().limit(MAX.toLong()).toArray()
        return String(cps, 0, cps.size).trim(' ')
    }

    private fun isRemoved(cp: Int) =
        cp <= 0x1f || cp in 0x7f..0x9f || cp == 0x061c || cp == 0x200e || cp == 0x200f ||
            cp in 0x202a..0x202e || cp in 0x2066..0x2069
}
