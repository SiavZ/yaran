/**
 * The machine window's vault reads of its route's session, off the main thread.
 *
 * Each read ends in exactly one [Read]: found, missing, locked, or unreadable. A record that
 * is there but cannot be read (tampered, corrupt, written for another host) is never treated
 * as "signed out": the window says so and offers to sign in again rather than starting a
 * sign-in by itself or loading without a credential.
 *
 * - The read runs on the runtime's io executor; the answer is posted to the main thread.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.SessionReads
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.os
 *
 * Used by:
 * io.github.siavz.yaran.machineview.SessionReads
 * └── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.os.Handler
import android.os.Looper

/** What a vault read of the route's session found; "unreadable" is never "absent". */
internal enum class Read { FOUND, MISSING, LOCKED, UNREADABLE }

internal class SessionReads(private val rt: () -> PluginRuntime, private val host: () -> String) {
    private val main = Handler(Looper.getMainLooper())

    fun <T> read(io: (String) -> T?, then: (Read, T?) -> Unit) {
        val runtime = rt()
        val h = host()
        runtime.io.execute {
            var value: T? = null
            val r = try {
                value = io(h)
                if (value == null) Read.MISSING else Read.FOUND
            } catch (e: VaultLockedException) {
                Read.LOCKED
            } catch (e: Exception) {
                runtime.core.diagnostics.append("machine-view session unreadable error=${e.javaClass.simpleName} host=$h")
                Read.UNREADABLE
            }
            main.post { then(r, value) }
        }
    }
}
