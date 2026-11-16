/// The native org API for other native code in the app (Phase 16's push registration).
///
/// The same `OrgApiClient` and `DeviceKeyStore` the Session plugin uses (`AppServices`), so a
/// W12 registration gets the same origin, install-id and device-key checks, and a
/// `device_revoked` answer wipes the org exactly as it does for the shell. Android twin:
/// `NativeOrgApi.kt`.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/NativeOrgApi
/// ├── MachineView/AppServices (inferred)
/// └── MachineViewCore/Outcomes (inferred)
/// External: Foundation
///
/// Used by:
/// MachineView/NativeOrgApi
/// └── App/AppDelegate (inferred)
/// <module-headers:end>
import Foundation
import MachineViewCore

public enum NativeOrgApi {
    /// The org's device public key (02 `P256Point`), minted with its install id on first use.
    @MainActor public static func devicePublicKey(orgId: String) throws -> String {
        try AppServices.shared.deviceKeys.ensure(orgId).publicKey
    }

    /// A `/v1/` call on the org origin recorded at onboarding; `body` is JSON text or nil.
    @MainActor public static func request(orgId: String, method: String, path: String, body: Data?) async -> ApiResult {
        let json = body.flatMap { try? JSONSerialization.jsonObject(with: $0) }
        return await AppServices.shared.api.request(orgId: orgId, method: method, path: path, body: json)
    }
}
