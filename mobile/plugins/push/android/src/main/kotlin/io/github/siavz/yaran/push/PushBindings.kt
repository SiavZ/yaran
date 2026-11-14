/**
 * The seams the app binds at startup: Phase 15's native org client, the build's push transport,
 * and (relay-fcm builds only) the FCM token source.
 *
 * Phase 15's `OrgApiClient` is the only code that talks to an org Worker and its
 * `DeviceKeyStore` holds the per-org device key (D22, D24). Registration needs the device
 * public key and one W12 call from them; the app installs an adapter over 15's types here, and
 * the tests install a fake.
 *
 * - `OrgApiResult` mirrors 15's `ApiResult` one for one.
 * - Set once from the app's `YaranApplication.onCreate`, before any service or plugin runs.
 *
 * <module-headers:begin>
 * Uses: none
 * External: org.json
 *
 * Used by:
 * io.github.siavz.yaran.push.PushBindings
 * ├── io.github.siavz.yaran.app.PushGateway
 * ├── io.github.siavz.yaran.app.PushGatewayTest
 * ├── io.github.siavz.yaran.app.YaranApplication
 * ├── io.github.siavz.yaran.push.DeviceRegistrar (inferred)
 * ├── io.github.siavz.yaran.push.DeviceRegistrarTest (inferred)
 * ├── io.github.siavz.yaran.push.PushPlugin (inferred)
 * └── io.github.siavz.yaran.push.fcmrelay.FcmRelayInstaller
 * <module-headers:end>
 */
package io.github.siavz.yaran.push

import org.json.JSONObject

sealed class OrgApiResult {
    data class Ok(val status: Int, val body: String) : OrgApiResult()
    data class ApiError(val status: Int, val code: String) : OrgApiResult()
    object SessionExpired : OrgApiResult()
    object DeviceRevoked : OrgApiResult()
    object Offline : OrgApiResult()
    object TlsError : OrgApiResult()
    object Refused : OrgApiResult()
    object ProtocolUnsupported : OrgApiResult()
}

interface OrgApiGateway {
    /** 02 `P256Point` of the org's device key (15's `DeviceKeyStore`). */
    fun devicePublicKey(orgId: String): String

    /** W12 `POST /v1/me/devices` through 15's `OrgApiClient` (it checks install id and key). */
    fun registerDevice(orgId: String, body: JSONObject): OrgApiResult
}

/** `yaran.playPushTransport` (Phase 14's publisher build config); `foss` is always UnifiedPush. */
enum class PushTransport { UNIFIED_PUSH, RELAY_FCM }

data class AppInfo(
    val applicationId: String,
    /** 02 `Flavor`: `foss` or `play`. */
    val flavor: String,
    val appVersion: String,
    val transport: PushTransport,
    /** HTTPS base URL of the publisher relay; used only by the relay-fcm transport. */
    val relayBaseUrl: String?,
)

object PushBindings {
    @Volatile var orgApi: OrgApiGateway? = null
    @Volatile var app: AppInfo? = null

    /** relay-fcm builds: blocks for the current FCM registration token, or null. */
    @Volatile var fcmToken: (() -> String?)? = null
}
