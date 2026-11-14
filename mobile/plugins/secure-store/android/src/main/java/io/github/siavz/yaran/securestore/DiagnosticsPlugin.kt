/**
 * DiagnosticsPlugin: the `Diagnostics` bridge object over the core ring log, plus the share sheet.
 *
 * `append` and `read` go straight to the core (which sanitizes every entry). `export` copies
 * the log to `cacheDir/diag-export/` and opens an `ACTION_SEND` chooser on a content URI from
 * [DiagnosticsFileProvider], whose authority is derived from the application id.
 *
 * - shortcut: Android does not report which target the user picked without a chooser
 *   IntentSender receiver, so `export` resolves `shared` once the chooser closes; upgrade if
 *   the shell ever needs to tell a share from a dismissal.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.securestore.DiagnosticsPlugin
 * ├── io.github.siavz.yaran.core.Diagnostics
 * ├── io.github.siavz.yaran.core.Vault
 * ├── io.github.siavz.yaran.securestore.SecureStorePlugin (inferred)
 * └── io.github.siavz.yaran.securestore.Validation (inferred)
 * External: android.content, androidx.activity.result, androidx.core.content, com.getcapacitor, com.getcapacitor.annotation, java.io
 *
 * Used by: entry point (Capacitor plugin class, listed in capacitor.plugins.json by the Capacitor CLI sync)
 * <module-headers:end>
 */
package io.github.siavz.yaran.securestore

import android.content.ClipData
import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import io.github.siavz.yaran.core.CoreError
import io.github.siavz.yaran.core.Diagnostics
import java.io.File
import java.io.IOException

/** Serves only the diagnostics export directory (see `res/xml/yaran_diagnostics_paths.xml`). */
class DiagnosticsFileProvider : FileProvider(R.xml.yaran_diagnostics_paths)

@CapacitorPlugin(name = "Diagnostics")
class DiagnosticsPlugin : Plugin() {
    private val log by lazy { Diagnostics.shared(context) }

    @PluginMethod
    fun append(call: PluginCall) =
        call.guarded {
            log.append(Validation.level(call.getString("level")), Validation.message(call.getString("message")))
            call.resolve()
        }

    @PluginMethod
    fun read(call: PluginCall) =
        call.guarded {
            call.resolve(JSObject().put("text", log.read()))
        }

    @PluginMethod
    fun export(call: PluginCall) =
        call.guarded {
            val file = File(File(context.cacheDir, "diag-export"), "yaran-diagnostics.txt")
            try {
                file.parentFile?.mkdirs()
                file.writeText(log.read())
            } catch (e: IOException) {
                throw CoreError.Unavailable("cannot write the diagnostics export", e)
            }
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.yaran.diagnostics", file)
            val send =
                Intent(Intent.ACTION_SEND)
                    .setType("text/plain")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            send.clipData = ClipData.newRawUri(file.name, uri)
            startActivityForResult(call, Intent.createChooser(send, null), "exportClosed")
        }

    @ActivityCallback
    fun exportClosed(
        call: PluginCall?,
        @Suppress("UNUSED_PARAMETER") result: ActivityResult,
    ) {
        call?.resolve(JSObject().put("outcome", "shared"))
    }
}
