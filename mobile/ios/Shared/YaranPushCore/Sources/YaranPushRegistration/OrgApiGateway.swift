/// The seam between push registration and Phase 15's native org API client (D22, D24).
///
/// Phase 15's `OrgApiClient` is the only code that talks to an org Worker and its
/// `DeviceKeyStore` holds the per-org device key. Push registration needs exactly two things
/// from them: the org's device public key and one W12 `POST /v1/me/devices`. The app binds an
/// adapter over 15's types; the tests bind a fake.
///
/// - `OrgApiResult` mirrors 15's `ApiResult` variants one for one.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranPushRegistration/OrgApiGateway
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// └── YaranPushRegistrationTests/StubURLProtocol (inferred)
/// <module-headers:end>
import Foundation

public enum OrgApiResult: Equatable, Sendable {
    case ok(status: Int, body: Data)
    /// A 02 error envelope; `code` is its `error.code`.
    case apiError(status: Int, code: String)
    case sessionExpired
    /// 15's client has already wiped the org's sessions, install id and device key.
    case deviceRevoked
    case offline
    case tlsError
    case refused
    case protocolUnsupported
}

public protocol OrgApiGateway: Sendable {
    /// 02 `P256Point` of the org's device key (15's `DeviceKeyStore`, minted with the install id).
    func devicePublicKey(orgId: String) async throws -> String
    /// W12 through 15's `OrgApiClient`; it checks `install_id` and `device_key` itself.
    func registerDevice(orgId: String, body: Data) async -> OrgApiResult
}
