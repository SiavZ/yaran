/**
 * The seams to Phase 14's native core library, and the one holder the app installs them in.
 *
 * Phase 14 owns the vault, app lock, diagnostics log and screen privacy (`mobile/plugins/core`).
 * This plugin codes against these small interfaces, so its tests use fakes; the app's
 * Application calls [CoreBindings.install] with [CoreAdapters.from], the real core, before any
 * activity or plugin runs. Uninstalled, every use fails closed with a clear error.
 *
 * - Implementations must be thread-safe: the plugins call them from a background executor.
 * - [DiagnosticsSink] lines are already free of secrets; the core sanitizes them again.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * io.github.siavz.yaran.machineview.CoreBindings
 * ├── io.github.siavz.yaran.app.YaranApplication
 * ├── io.github.siavz.yaran.machineview.CoreAdapters (inferred)
 * ├── io.github.siavz.yaran.machineview.CoreAdaptersTest (inferred)
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.Fakes (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClient (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.InstallIdStore (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineViewActivity (inferred)
 * ├── io.github.siavz.yaran.machineview.MachineWindowRobolectricTest (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionPlugin (inferred)
 * ├── io.github.siavz.yaran.machineview.SessionStore (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

enum class ProtectionClass { STANDARD, LOCKED }

class VaultLockedException : Exception("the vault is locked")

/** Namespaced encrypted blobs (Phase 14 `Vault`). */
interface SecretVault {
    /** The blob, or null when absent; throws [VaultLockedException] while its class is locked. */
    fun read(ns: String): ByteArray?

    fun write(ns: String, value: ByteArray, cls: ProtectionClass)

    fun delete(ns: String)

    /** Every namespace starting with [prefix]. */
    fun list(prefix: String): List<String>
}

fun interface DiagnosticsSink {
    fun append(line: String)
}

/** The org URL recorded at onboarding (Phase 14's org record), never a URL from JS. */
fun interface OrgDirectory {
    fun orgUrl(orgId: String): String?
}

interface AppLockState {
    fun lockEnabled(): Boolean

    fun isLocked(): Boolean
}

fun interface ScreenPrivacyState {
    fun enabled(): Boolean
}

class CoreBindings(
    val vault: SecretVault,
    val diagnostics: DiagnosticsSink,
    val orgs: OrgDirectory,
    val appLock: AppLockState,
    val screenPrivacy: ScreenPrivacyState,
) {
    companion object {
        @Volatile private var installed: CoreBindings? = null

        /** Called once by the app before the Capacitor bridge starts. */
        @JvmStatic
        fun install(bindings: CoreBindings) {
            installed = bindings
        }

        fun require(): CoreBindings =
            installed ?: throw IllegalStateException("machine-view: the app has not installed its core bindings")
    }
}
