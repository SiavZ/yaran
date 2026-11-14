/**
 * The per-org `InstallId` (02 §2): minted once per org registration on this install.
 *
 * Kept in vault namespace `install/<orgId>` in the standard class, so background work
 * (Phase 16) can reach it, together with whether `POST /v1/me/devices` has succeeded, which
 * decides when the org API client starts sending `Yaran-Install-Id`. It is an identifier,
 * not a credential, so JS may read it.
 *
 * - Minted only through [DeviceKeyStore.ensure], which keeps it one unit with the device key.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.InstallIdStore
 * └── io.github.siavz.yaran.machineview.CoreBindings (inferred)
 * External: java.util, org.json
 *
 * Used by:
 * io.github.siavz.yaran.machineview.InstallIdStore
 * ├── io.github.siavz.yaran.machineview.DeviceKeyStore (inferred)
 * ├── io.github.siavz.yaran.machineview.HandoffClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClient (inferred)
 * ├── io.github.siavz.yaran.machineview.OrgApiClientTest (inferred)
 * ├── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * └── io.github.siavz.yaran.machineview.StoresTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import org.json.JSONObject
import java.util.UUID

internal data class InstallRecord(val installId: String, val registered: Boolean)

internal class InstallIdStore(private val vault: SecretVault) {
    private fun ns(orgId: String) = "install/$orgId"

    fun get(orgId: String): InstallRecord? {
        val bytes = vault.read(ns(orgId)) ?: return null
        val o = JSONObject(String(bytes, Charsets.UTF_8))
        return InstallRecord(o.getString("install_id"), o.optBoolean("registered", false))
    }

    fun mint(orgId: String): InstallRecord = InstallRecord(UUID.randomUUID().toString().lowercase(), false).also { put(orgId, it) }

    fun markRegistered(orgId: String) {
        val r = get(orgId) ?: return
        if (!r.registered) put(orgId, r.copy(registered = true))
    }

    fun delete(orgId: String) = vault.delete(ns(orgId))

    private fun put(orgId: String, r: InstallRecord) {
        val json = JSONObject().put("install_id", r.installId).put("registered", r.registered).toString()
        vault.write(ns(orgId), json.toByteArray(Charsets.UTF_8), ProtectionClass.STANDARD)
    }
}
