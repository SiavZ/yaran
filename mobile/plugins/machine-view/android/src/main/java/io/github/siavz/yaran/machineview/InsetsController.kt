/**
 * Applies the [InsetsMode] to the machine window's container.
 *
 * Pass-through pads nothing and forwards the insets untouched, so `env(safe-area-inset-*)`
 * and the IME visual-viewport resize reach yaran's own viewport handling. The padding modes
 * pad the container and hand the WebView zeroed insets, never `CONSUMED` (which would hide
 * them from every sibling too).
 *
 * - Main thread.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.InsetsController
 * └── io.github.siavz.yaran.machineview.InsetsMode (inferred)
 * External: android.view, androidx.core.graphics, androidx.core.view
 *
 * Used by:
 * io.github.siavz.yaran.machineview.InsetsController
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

internal object InsetsController {
    fun apply(container: View, mode: InsetsMode) {
        val bars = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            when (mode) {
                InsetsMode.PASS_THROUGH -> {
                    v.setPadding(0, 0, 0, 0)
                    insets
                }
                InsetsMode.PAD_SYSTEM_BARS -> {
                    val b = insets.getInsets(bars)
                    v.setPadding(b.left, b.top, b.right, b.bottom)
                    WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build()
                }
                InsetsMode.PAD_SYSTEM_BARS_AND_IME -> {
                    val b = insets.getInsets(bars)
                    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
                    v.setPadding(b.left, b.top, b.right, maxOf(b.bottom, ime.bottom))
                    WindowInsetsCompat.Builder(insets).setInsets(bars or WindowInsetsCompat.Type.ime(), Insets.NONE).build()
                }
            }
        }
    }
}
