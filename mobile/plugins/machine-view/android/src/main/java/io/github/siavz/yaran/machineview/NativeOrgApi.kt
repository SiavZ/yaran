/**
 * The native org API for other native code in the app (Phase 16's push registration).
 *
 * The same [OrgApiClient] and [DeviceKeyStore] the Session plugin uses, so a W12 registration
 * gets the same origin, install-id and device-key checks, and a `device_revoked` answer wipes
 * the org exactly as it does for the shell. Blocking: call it off the main thread.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.machineview.NativeOrgApi
 * ├── io.github.siavz.yaran.machineview.Outcomes (inferred)
 * └── io.github.siavz.yaran.machineview.PluginRuntime (inferred)
 * External: android.content
 *
 * Used by:
 * io.github.siavz.yaran.machineview.NativeOrgApi
 * └── io.github.siavz.yaran.app.PushGateway
 * <module-headers:end>
 */
package io.github.siavz.yaran.machineview

import android.content.Context

object NativeOrgApi {
    /** The org's device public key (02 `P256Point`), minted with its install id on first use. */
    fun devicePublicKey(context: Context, orgId: String): String = PluginRuntime.get(context).deviceKeys.ensure(orgId).publicKey

    /** A `/v1/` call on the org origin recorded at onboarding; [body] is a JSON object or null. */
    fun request(context: Context, orgId: String, method: String, path: String, body: Any?): ApiResult =
        PluginRuntime.get(context).orgApi.request(orgId, method, path, body)
}
