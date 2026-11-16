/**
 * How the machine window handles system-bar, cutout and IME insets, by WebView version.
 *
 * From M144 the WebView exposes system-bar and cutout insets as `safe-area-inset-*` at any
 * size and resizes the visual viewport for the IME (M139), so the window pads nothing and
 * zeroes the insets it forwards (never consuming them). M139-M143 pads the system bars and
 * lets the IME resize natively; older WebViews pad system bars and the IME (adjust-resize).
 *
 * - Pure. `forcePadding` is the G6 fallback (forced padding mode).
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.InsetsMode
 * ├── io.github.siavz.yaran.machineview.InsetsController (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.PolicyFixtureTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

internal enum class InsetsMode {
    PASS_THROUGH,
    PAD_SYSTEM_BARS,
    PAD_SYSTEM_BARS_AND_IME;

    companion object {
        fun forWebViewVersion(versionName: String?, forcePadding: Boolean): InsetsMode {
            if (forcePadding) return PAD_SYSTEM_BARS_AND_IME
            val major = versionName?.substringBefore('.')?.toIntOrNull() ?: return PAD_SYSTEM_BARS_AND_IME
            return when {
                major >= 144 -> PASS_THROUGH
                major >= 139 -> PAD_SYSTEM_BARS
                else -> PAD_SYSTEM_BARS_AND_IME
            }
        }
    }
}
