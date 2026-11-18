/**
 * The native password sheet for a direct machine (G1): the one place the password is typed.
 *
 * A platform dialog over whichever activity asked (the shell or the machine window), with
 * `FLAG_SECURE`, a password input that password managers may fill, and the host named in the
 * title. The password leaves the field as a `CharArray` (the field is cleared at once) and
 * never becomes a String, a JS value or a log line; the caller zeroes it after the POST.
 *
 * - Main thread. Exactly one of `onSubmit` and `onCancel` runs.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.PasswordSheet
 * └── io.github.siavz.yaran.machineview.Messages (inferred)
 * External: android.app, android.os, android.text, android.view, android.widget
 *
 * Used by:
 * io.github.siavz.yaran.machineview.PasswordSheet
 * └── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.app.AlertDialog
import android.os.Build
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.FrameLayout

internal object PasswordSheet {
    fun show(activity: Activity, host: String, onSubmit: (CharArray) -> Unit, onCancel: () -> Unit): AlertDialog {
        var ended = false
        val field = EditText(activity).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
                setAutofillHints(View.AUTOFILL_HINT_PASSWORD)
            }
            // Not setSingleLine: it swaps the password transformation for a plain one.
            maxLines = 1
        }
        val box = FrameLayout(activity).apply {
            val pad = (20 * activity.resources.displayMetrics.density).toInt()
            setPadding(pad, 0, pad, 0)
            addView(field)
        }
        val row = Messages.overlay.getValue("password_sheet")
        val vars = mapOf("host" to host, "machine" to host)
        val dialog = AlertDialog.Builder(activity)
            .setTitle("Sign in to $host")
            .setMessage(Messages.fill(row.message, vars))
            .setView(box)
            .setPositiveButton(label(row.actions[0])) { _, _ ->
                ended = true
                val text = field.text
                val chars = CharArray(text.length).also { text.getChars(0, text.length, it, 0) }
                text.clear()
                onSubmit(chars)
            }
            .setNegativeButton(label(row.actions[1])) { _, _ -> }
            .setOnDismissListener {
                field.text.clear()
                if (!ended) {
                    ended = true
                    onCancel()
                }
            }
            .create()
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show()
        field.requestFocus()
        return dialog
    }

    private fun label(action: String) = when (action) {
        "sign_in" -> "Sign in"
        "cancel" -> "Cancel"
        else -> action
    }
}
