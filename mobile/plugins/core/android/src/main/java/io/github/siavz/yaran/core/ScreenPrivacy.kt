/**
 * ScreenPrivacy: keeps app windows out of screenshots, screen recordings and the recents view.
 *
 * When the persisted setting is on, every activity window of the app gets `FLAG_SECURE`, the
 * shell's and Phase 15's machine-view window alike. The setting is read natively at launch,
 * so it applies before the shell has loaded.
 *
 * - [install] registers activity lifecycle callbacks once per process; later activities are
 *   covered as they are created, and a change is applied to every live activity at once.
 * - Main-thread only for window changes (applied through `runOnUiThread`).
 *
 * <module-headers:begin>
 * Uses: none
 * External: android.app, android.content, android.os, android.view, java.util
 *
 * Used by:
 * io.github.siavz.yaran.core.ScreenPrivacy
 * ├── io.github.siavz.yaran.app.MainActivity
 * ├── io.github.siavz.yaran.machineview.CoreAdapters
 * └── io.github.siavz.yaran.securestore.ScreenPrivacyPlugin
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.view.WindowManager
import java.util.Collections
import java.util.WeakHashMap

class ScreenPrivacy private constructor(
    context: Context,
) : Application.ActivityLifecycleCallbacks {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val activities: MutableSet<Activity> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    val enabled: Boolean get() = prefs.getBoolean(KEY_ENABLED, false)

    /** Persists the setting and applies it to every live activity. */
    fun set(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
        synchronized(activities) { activities.toList() }.forEach { activity -> activity.runOnUiThread { apply(activity) } }
    }

    private fun apply(activity: Activity) {
        if (enabled) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
    }

    override fun onActivityCreated(
        activity: Activity,
        savedInstanceState: Bundle?,
    ) {
        activities.add(activity)
        apply(activity)
    }

    override fun onActivityDestroyed(activity: Activity) {
        activities.remove(activity)
    }

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(
        activity: Activity,
        outState: Bundle,
    ) = Unit

    companion object {
        private const val PREFS = "yaran.screenprivacy"
        private const val KEY_ENABLED = "enabled"

        @Volatile private var instance: ScreenPrivacy? = null
        private var registered = false

        fun shared(context: Context): ScreenPrivacy =
            instance ?: synchronized(this) {
                instance ?: ScreenPrivacy(context.applicationContext).also { instance = it }
            }

        /**
         * Registers the callbacks (once) and covers [current], which is already past
         * `onCreate` when an activity installs this from its own `onCreate`.
         */
        fun install(current: Activity): ScreenPrivacy {
            val privacy = shared(current)
            synchronized(this) {
                if (!registered) current.application.registerActivityLifecycleCallbacks(privacy)
                registered = true
            }
            privacy.onActivityCreated(current, null)
            return privacy
        }
    }
}
