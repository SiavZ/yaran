/**
 * The phone app's Application: wires the native plugins to the core before anything runs.
 *
 * The machine-view plugin's sign-in callback and the push service can each start a fresh
 * process before MainActivity or the Capacitor bridge exist, so the machine-view core bindings
 * and the push bindings (Phase 15's org client, the build's push facts) are installed here.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.YaranApplication
 * ├── io.github.siavz.yaran.app.PushGateway (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdapters
 * ├── io.github.siavz.yaran.machineview.CoreBindings
 * └── io.github.siavz.yaran.push.PushBindings
 * External: android.app
 *
 * Used by: entry point (the Application class, android:name in mobile/android/app/src/main/AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import android.app.Application
import io.github.siavz.yaran.machineview.CoreAdapters
import io.github.siavz.yaran.machineview.CoreBindings
import io.github.siavz.yaran.push.PushBindings

class YaranApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CoreBindings.install(CoreAdapters.from(this))
        PushBindings.orgApi = PushGateway(this)
        PushBindings.app = pushAppInfo()
    }
}
