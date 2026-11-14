/**
 * The machine window's native overlays (reauth, refusals, offline, TLS), banner and lock cover.
 *
 * Built in code, no layout resources: a full-pane panel with one sentence and its actions, or
 * a top banner with Renew. Sentences and actions come from [Messages], the shared failure
 * table. Colors resolve from the activity theme until Phase 14 exports the ui-kit colors.
 *
 * - Main thread. Buttons keep the platform's 48dp touch target.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.OverlayView
 * └── io.github.siavz.yaran.machineview.Messages (inferred)
 * External: android.content, android.util, android.view, android.widget
 *
 * Used by:
 * io.github.siavz.yaran.machineview.OverlayView
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Context
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

internal class OverlayView(context: Context, private val banner: Boolean, private val onAction: (String) -> Unit) : FrameLayout(context) {
    private val text = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, if (banner) 15f else 18f)
        gravity = if (banner) Gravity.START else Gravity.CENTER
        setTextColor(themeColor(android.R.attr.textColorPrimary))
    }
    private val buttons = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }

    /** The kind currently shown, or null when hidden. */
    var shown: String? = null
        private set

    init {
        setBackgroundColor(themeColor(android.R.attr.colorBackground))
        isClickable = true
        val column = LinearLayout(context).apply {
            orientation = if (banner) LinearLayout.HORIZONTAL else LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            val pad = dp(if (banner) 12 else 32)
            setPadding(pad, pad, pad, pad)
            addView(text, LinearLayout.LayoutParams(if (banner) 0 else LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, if (banner) 1f else 0f))
            addView(buttons)
        }
        addView(column, LayoutParams(LayoutParams.MATCH_PARENT, if (banner) LayoutParams.WRAP_CONTENT else LayoutParams.MATCH_PARENT))
        visibility = View.GONE
    }

    fun show(kind: String, vars: Map<String, String>, detail: String? = null) {
        val row = Messages.overlay.getValue(kind)
        text.text = Messages.fill(row.message, vars) + (detail?.let { "\n\n$it" } ?: "")
        buttons.removeAllViews()
        for (action in row.actions) {
            buttons.addView(Button(context).apply {
                this.text = label(action)
                setOnClickListener { onAction(action) }
            }, LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { setMargins(dp(8), dp(16), dp(8), 0) })
        }
        shown = kind
        visibility = View.VISIBLE
    }

    /** Free text (the lock cover), with no actions. */
    fun showText(message: String) {
        text.text = message
        buttons.removeAllViews()
        shown = "text"
        visibility = View.VISIBLE
    }

    fun hide() {
        shown = null
        visibility = View.GONE
    }

    private fun label(action: String) = when (action) {
        "sign_in" -> "Sign in"
        "back_to_machines" -> "Back to machines"
        "retry" -> "Retry"
        "renew" -> "Renew"
        else -> action
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun themeColor(attr: Int): Int {
        val tv = TypedValue()
        context.theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) context.getColor(tv.resourceId) else tv.data
    }
}
