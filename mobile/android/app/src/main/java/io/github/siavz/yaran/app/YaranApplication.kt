/**
 * The phone app's Application: wires the native plugins to the core before anything runs.
 *
 * The machine-view plugin's sign-in callback can start a fresh process through its own
 * activity, before MainActivity or the Capacitor bridge exist, so its core bindings are
 * installed here rather than in an activity.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.YaranApplication
 * ├── io.github.siavz.yaran.machineview.CoreAdapters
 * └── io.github.siavz.yaran.machineview.CoreBindings
 * External: android.app
 *
 * Used by: entry point (the Application class, android:name in mobile/android/app/src/main/AndroidManifest.xml)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import android.app.Application
import io.github.siavz.yaran.machineview.CoreAdapters
import io.github.siavz.yaran.machineview.CoreBindings

class YaranApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        CoreBindings.install(CoreAdapters.from(this))
    }
}
