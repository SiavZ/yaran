/**
 * Phase 16's push plugin bound to Phase 15's native org client, plus the build facts it needs.
 *
 * [PushGateway] answers the push plugin's [OrgApiGateway] through [NativeOrgApi], so W12
 * registration rides the same checks as every other org call; [pushAppInfo] reads the
 * flavor, version, transport and relay URL this build was compiled with.
 *
 * - The relay-fcm transport exists only in play builds compiled with it; foss is UnifiedPush.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.app.PushGateway
 * ├── io.github.siavz.yaran.machineview.NativeOrgApi
 * ├── io.github.siavz.yaran.machineview.Outcomes
 * └── io.github.siavz.yaran.push.PushBindings
 * External: android.content, org.json
 *
 * Used by:
 * io.github.siavz.yaran.app.PushGateway
 * ├── io.github.siavz.yaran.app.PushGatewayTest (inferred)
 * └── io.github.siavz.yaran.app.YaranApplication (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.app

import android.content.Context
import io.github.siavz.yaran.machineview.ApiResult
import io.github.siavz.yaran.machineview.NativeOrgApi
import io.github.siavz.yaran.push.AppInfo
import io.github.siavz.yaran.push.OrgApiGateway
import io.github.siavz.yaran.push.OrgApiResult
import io.github.siavz.yaran.push.PushTransport
import org.json.JSONException
import org.json.JSONObject

class PushGateway(
    private val context: Context,
) : OrgApiGateway {
    override fun devicePublicKey(orgId: String): String = NativeOrgApi.devicePublicKey(context, orgId)

    override fun registerDevice(
        orgId: String,
        body: JSONObject,
    ): OrgApiResult = toPush(NativeOrgApi.request(context, orgId, "POST", "/v1/me/devices", body))
}

/** Phase 15's result in the push plugin's terms; an envelope's `error.code` is kept. */
fun toPush(result: ApiResult): OrgApiResult =
    when (result) {
        is ApiResult.Ok -> OrgApiResult.Ok(result.status, result.bodyJson ?: "null")
        is ApiResult.ApiError -> OrgApiResult.ApiError(result.status, errorCode(result.envelopeJson))
        ApiResult.SessionExpired -> OrgApiResult.SessionExpired
        ApiResult.DeviceRevoked -> OrgApiResult.DeviceRevoked
        ApiResult.Offline -> OrgApiResult.Offline
        ApiResult.TlsError -> OrgApiResult.TlsError
        is ApiResult.Refused -> OrgApiResult.Refused
        is ApiResult.ProtocolUnsupported -> OrgApiResult.ProtocolUnsupported
    }

private fun errorCode(envelope: String): String =
    try {
        JSONObject(envelope).getJSONObject("error").getString("code")
    } catch (e: JSONException) {
        "unknown"
    }

fun pushAppInfo(): AppInfo =
    AppInfo(
        applicationId = BuildConfig.APPLICATION_ID,
        flavor = BuildConfig.FLAVOR,
        appVersion = BuildConfig.VERSION_NAME,
        transport =
            if (BuildConfig.FLAVOR == "play" && BuildConfig.PLAY_PUSH_TRANSPORT == "relay-fcm") PushTransport.RELAY_FCM else PushTransport.UNIFIED_PUSH,
        relayBaseUrl = BuildConfig.RELAY_URL.ifEmpty { null },
    )
