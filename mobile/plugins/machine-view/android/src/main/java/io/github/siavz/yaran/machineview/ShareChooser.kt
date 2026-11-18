/**
 * The files a machine window holds from a share (G5), and the confirm in front of the page's
 * file chooser.
 *
 * The window got the URIs in its own intent's `ClipData` with a read grant (see
 * `MachineViewPlugin.open`), so they stay readable while the window lives. When the page asks
 * for files (only where the web offers "Attach a file…", which it does only for the device
 * driving the pane) this asks "Attach the N shared files here?" first: Attach answers the
 * page's own chooser with them (only the first when the input takes one file), Choose other
 * files falls through to the system picker, and backing out answers nothing. The page uploads,
 * rechecks ownership and toasts exactly as for a picked file; nothing is uploaded natively.
 *
 * - Main thread. Never persisted: Discard, delivery or the window closing forgets the URIs.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.ShareChooser
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.Messages (inferred)
 * └── io.github.siavz.yaran.machineview.ShareHolder (inferred)
 * External: android.app, android.content, android.net
 *
 * Used by:
 * io.github.siavz.yaran.machineview.ShareChooser
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri

internal class ShareChooser(private val activity: Activity, private val changed: (Int) -> Unit) {
    var uris: List<Uri> = emptyList()
        private set

    /** The shared files a fresh window intent carries; none for a restored window (the grant died with the process). */
    fun take(intent: Intent?, restored: Boolean) {
        if (restored || intent?.getBooleanExtra(MachineViewActivity.K_SHARE, false) != true) return
        val clip = intent.clipData ?: return
        uris = ShareHolder.select((0 until clip.itemCount).map { clip.getItemAt(it).uri }).first
        changed(uris.size)
    }

    private var confirm: AlertDialog? = null

    /**
     * The page the confirm was asked by is going (a route switch, a new target, the window
     * closing): the confirm is dismissed, so that page's chooser is answered with nothing,
     * once, and the held files stay for whatever page asks next.
     */
    fun cancelConfirm() {
        confirm?.dismiss()
        confirm = null
    }

    /** Forgets the files; an open confirm is dismissed, so its page chooser is answered with nothing. */
    fun discard() {
        confirm?.dismiss()
        confirm = null
        uris = emptyList()
        changed(0)
    }

    /**
     * Offers the held files to a page chooser; false when none are held, so the caller opens
     * the system picker as before. [deliver] runs at most once; [pick] opens the picker. The
     * files are the ones held when the confirm opened: a replaced target's files never answer it.
     */
    fun offer(multiple: Boolean, deliver: (Array<Uri>?) -> Unit, pick: () -> Unit): Boolean {
        val held = uris
        if (held.isEmpty()) return false
        var answered = false
        val row = Messages.overlay.getValue(if (multiple || held.size == 1) "share_confirm" else "share_confirm_single")
        confirm = AlertDialog.Builder(activity)
            .setMessage(Messages.fill(row.message, mapOf("count" to held.size.toString())))
            .setPositiveButton("Attach shared files") { _, _ ->
                answered = true
                if (uris !== held) return@setPositiveButton deliver(null)
                confirm = null
                discard()
                deliver((if (multiple) held else held.take(1)).toTypedArray())
            }
            .setNegativeButton("Choose other files") { _, _ ->
                answered = true
                pick()
            }
            .setOnDismissListener { if (!answered) deliver(null) }
            .show()
        return true
    }
}
