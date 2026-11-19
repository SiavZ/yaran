/**
 * The machine WebView's chrome policy: file chooser, permissions, windows.
 *
 * File inputs open the system picker through a launcher the activity registered in onCreate,
 * after offering any files held from a share (G5), and the callback fires exactly once, with
 * only `content://` results. Every permission
 * request (camera, microphone, MIDI, protected media) and geolocation is denied: yaran's UI
 * needs none. New windows are never created (multiple windows are off).
 *
 * - Main thread.
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.content, android.net, android.webkit
 *
 * Used by:
 * io.github.siavz.yaran.machineview.MachineChromeClient
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * └── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Intent
import android.net.Uri
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

internal class MachineChromeClient(
    private val launchChooser: (Intent, (Array<Uri>?) -> Unit) -> Boolean,
    /** Offers held shared files first (G5); false when there are none. */
    private val offerShare: (multiple: Boolean, deliver: (Array<Uri>?) -> Unit, pick: () -> Unit) -> Boolean = { _, _, _ -> false },
) : WebChromeClient() {
    override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        var delivered = false
        val once: (Array<Uri>?) -> Unit = { uris ->
            if (!delivered) {
                delivered = true
                callback.onReceiveValue(contentOnly(uris))
            }
        }
        val pick = {
            val started = try {
                launchChooser(params.createIntent(), once)
            } catch (e: RuntimeException) {
                false
            }
            if (!started) once(null)
        }
        if (!offerShare(params.mode == FileChooserParams.MODE_OPEN_MULTIPLE, once, pick)) pick()
        return true
    }

    override fun onPermissionRequest(request: PermissionRequest) = request.deny()

    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) =
        callback.invoke(origin, false, false)

    companion object {
        fun contentOnly(uris: Array<Uri>?): Array<Uri>? = uris?.filter { it.scheme == "content" }?.toTypedArray()?.takeIf { it.isNotEmpty() }
    }
}
