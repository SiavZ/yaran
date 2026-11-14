/// The publisher push relay client: R1 `GET /v1/meta` and R2 `POST /v1/endpoints` (02 §5).
///
/// Checks that the relay serves this app (`apps` holds the bundle id) on the APNs channel, then
/// mints the per-org endpoint with 02's `ApnsMintRequest`. The relay holds no user credential,
/// so this is the one native call that does not go through Phase 15's org client.
///
/// - The base URL is a build-time setting (D11, D16) and must be HTTPS; anything else is
///   refused before a request is made.
/// - Relay answers are attacker-influenced text: only the 02 error code is kept, never a body.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranPushRegistration/RelayEndpointClient
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation

public enum RelayError: Error, Equatable, Sendable {
    case insecureBaseURL
    case notYaranRelay
    case appNotServed
    case channelNotServed
    case rateLimited(retryAfter: Int?)
    case unavailable(status: Int)
    case api(status: Int, code: String)
    case malformedResponse
    case network
}

public struct RelayEndpointClient: Sendable {
    public enum Channel: String, Sendable { case apns, fcm }

    let baseURL: URL
    let appId: String
    let session: URLSession

    public init(baseURL: URL, appId: String, session: URLSession = .shared) throws {
        guard baseURL.scheme?.lowercased() == "https", baseURL.host?.isEmpty == false else {
            throw RelayError.insecureBaseURL
        }
        self.baseURL = baseURL
        self.appId = appId
        self.session = session
    }

    /// R1: returns the relay's `endpoint_key_id` once this app and channel are served.
    public func endpointKeyId(channel: Channel) async throws -> String {
        let object = try await send(URLRequest(url: baseURL.appendingPathComponent("v1/meta")), expect: 200)
        guard object["service"] as? String == "yaran-push-relay",
              let apps = object["apps"] as? [String], let channels = object["channels"] as? [String],
              let kid = object["endpoint_key_id"] as? String
        else { throw RelayError.notYaranRelay }
        guard apps.contains(appId) else { throw RelayError.appNotServed }
        guard channels.contains(channel.rawValue) else { throw RelayError.channelNotServed }
        return kid
    }

    /// 02 `ApnsMintRequest`, as sent.
    public func apnsMintBody(token: String, environment: String, vapidPublicKey: String, registrationId: String) -> [String: String] {
        [
            "kind": "apns", "app_id": appId, "apns_token": token, "apns_environment": environment,
            "vapid_public_key": vapidPublicKey, "registration_id": registrationId,
        ]
    }

    /// R2: mints one endpoint and returns it (a capability that stays in native code).
    public func mint(body: [String: String]) async throws -> String {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/endpoints"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        let object = try await send(request, expect: 201)
        guard let endpoint = object["endpoint"] as? String,
              endpoint.range(of: Self.endpointPattern, options: .regularExpression) == endpoint.startIndex..<endpoint.endIndex
        else { throw RelayError.malformedResponse }
        return endpoint
    }

    static let endpointPattern = "^https://[^/]+/w/v1\\.[A-Za-z0-9_-]{1,16}\\.[A-Za-z0-9_-]{16,1024}$"

    private func send(_ request: URLRequest, expect: Int) async throws -> [String: Any] {
        var request = request
        request.timeoutInterval = 15
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RelayError.network
        }
        guard let http = response as? HTTPURLResponse else { throw RelayError.malformedResponse }
        let object = (try? JSONSerialization.jsonObject(with: data.prefix(64 * 1024))) as? [String: Any]
        switch http.statusCode {
        case expect:
            guard let object else { throw RelayError.malformedResponse }
            return object
        case 429:
            throw RelayError.rateLimited(retryAfter: http.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) })
        case 500...599:
            if let code = errorCode(object), http.statusCode != 503 { throw RelayError.api(status: http.statusCode, code: code) }
            throw RelayError.unavailable(status: http.statusCode)
        default:
            guard let code = errorCode(object) else { throw RelayError.malformedResponse }
            throw RelayError.api(status: http.statusCode, code: code)
        }
    }

    private func errorCode(_ object: [String: Any]?) -> String? {
        guard let code = (object?["error"] as? [String: Any])?["code"] as? String,
              code.range(of: "^[a-z_]{1,64}$", options: .regularExpression) != nil
        else { return nil }
        return code
    }
}
