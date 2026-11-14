/**
 * Gate spike main activity: the Capacitor bridge host that registers the in-app spike plugins.
 *
 * Capacitor only auto-discovers npm plugins, so the three local spike plugins are registered
 * by hand here, before `super.onCreate` builds the bridge (Capacitor's documented order).
 *
 * - Runs on the main thread; holds no state of its own.
 * - The bridge WebView it hosts is the only bridge-enabled page (D9); machine-view is not it.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gatespike.MainActivity
 * ├── io.github.siavz.yaran.gatespike.MachineViewSpike
 * ├── io.github.siavz.yaran.gatespike.AuthSpike
 * └── io.github.siavz.yaran.gatespike.PushSpike
 * External: com.getcapacitor
 *
 * Used by:
 * io.github.siavz.yaran.gatespike.MainActivity
 * └── entry point (launcher Activity, AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gatespike

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(MachineViewSpike::class.java)
        registerPlugin(AuthSpike::class.java)
        registerPlugin(PushSpike::class.java)
        super.onCreate(savedInstanceState)
    }
}
