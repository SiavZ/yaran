/**
 * The process-wide wiring of the plugin: stores, clients and build facts from one place.
 *
 * Built lazily from Phase 14's [CoreBindings] plus the merged manifest's meta-data (the
 * publisher domain decides [CallbackMode]; empty means a dev build) and the app's version
 * (the UA token). Both plugins and both activities share this one instance, so there is one
 * pending handoff and one view of the vault per process.
 *
 * - Thread-safe lazy init. Blocking members run on [io].
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.PluginRuntime
 * ├── io.github.siavz.yaran.machineview.AndroidKeyStoreBackend (inferred)
 * ├── io.github.siavz.yaran.machineview.CallbackUrl (inferred)
 * ├── io.github.siavz.yaran.machineview.CookieInjector (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceLabel (inferred)
 * ├── io.github.siavz.yaran.machineview.Direct (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectAuth (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.UaToken (inferred)
 * External: android.content, android.content.pm, android.os, android.provider, java.util.concurrent
 *
 * Used by:
 * io.github.siavz.yaran.machineview.PluginRuntime
 * ├── io.github.siavz.yaran.machineview.AbandonedLoginRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AdmissionRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.AuthTabRegistryRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.BrowserLauncher (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdaptersTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectFlow (inferred)
 * ├── io.github.siavz.yaran.machineview.DirectWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.FreshSignInRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.NativeOrgApi (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionGenerationRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionReads (inferred)
 * ├── io.github.siavz.yaran.machineview.StaleOpenRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.UpgradeRequiredRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.WindowRepairRobolectricTest (inferred)
 * └── io.github.siavz.yaran.machineview.WindowRound12RobolectricTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class PluginRuntime private constructor(context: Context) {
    private val app = context.applicationContext
    val core = CoreBindings.require()
    val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "machine-view-io") }
    val mode: CallbackMode
    val webViewDebug: Boolean
    val uaToken: String
    val cookies = CookieInjector()
    val installIds = InstallIdStore(core.vault)
    val deviceKeys = DeviceKeyStore(AndroidKeyStoreBackend(), installIds, core.diagnostics)
    val sessions = SessionStore(core.vault, core.diagnostics, cookies)
    /** A var only so the sign-in tests can give it a software device key. */
    internal var handoff: HandoffClient
    val orgApi: OrgApiClient
    val deviceLabel: String
    val directSessions = DirectSessionStore(core.vault)
    /** A var only so the window tests can point it at a local server. */
    internal var directAuth: DirectAuth

    init {
        val meta = app.packageManager.getApplicationInfo(app.packageName, PackageManager.GET_META_DATA).metaData
        val domain = meta?.getString(META_DOMAIN).orEmpty()
        mode = if (domain.isEmpty()) CallbackMode.Dev else CallbackMode.Https(domain)
        val debuggable = app.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        webViewDebug = debuggable || meta?.getString(META_E2E) == "true"
        val version = app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "0.0.0"
        uaToken = UaToken.token(version, "android", UaToken.formFor(app.resources.configuration.smallestScreenWidthDp))
        val label = DeviceLabel.clean(Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME), Build.MODEL ?: "")
        deviceLabel = label
        directAuth = DirectAuth(uaToken, core.diagnostics)
        val now = { System.currentTimeMillis() / 1000 }
        handoff = HandoffClient(core.vault, core.orgs, sessions, deviceKeys, mode, label, now, core.diagnostics, core.appLock)
        orgApi = OrgApiClient(core.orgs, sessions, installIds, deviceKeys, ::wipeOrg, uaToken, now, core.diagnostics)
    }

    /**
     * `device_revoked`, sign-out and org removal: sessions, cookies, install id and device key go
     * together. A sign-out that could not find every session throws first, so the device identity is
     * kept for a retry rather than deleted under a cleanup that did not finish.
     */
    fun wipeOrg(orgId: String, hosts: List<String> = emptyList()) = wipeOrgData(sessions, deviceKeys, orgId, hosts)

    companion object {
        const val META_DOMAIN = "io.github.siavz.yaran.machineview.publisherDomain"
        const val META_E2E = "io.github.siavz.yaran.machineview.e2eWebViewDebug"

        @Volatile private var instance: PluginRuntime? = null

        fun get(context: Context): PluginRuntime =
            instance ?: synchronized(this) { instance ?: PluginRuntime(context).also { instance = it } }
    }
}

/** [PluginRuntime.wipeOrg]: the sessions first, and only once they are all gone the device identity. */
internal fun wipeOrgData(sessions: SessionStore, deviceKeys: DeviceKeyStore, orgId: String, hosts: List<String>) {
    sessions.signOut(orgId, hosts)
    deviceKeys.delete(orgId)
}
