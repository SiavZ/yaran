/// The app's only client of an org Worker (D22): every `/v1/*` call, push registration included.
///
/// Requests go to the org origin recorded at onboarding, never anywhere else, with the
/// control-plane token as both `Cookie: CF_Authorization` and `cf-access-token` (Phase 02 §2),
/// the UA token as the whole `User-Agent`, `Yaran-Protocol`, and `Yaran-Install-Id` once the
/// device is registered. A registration body naming another `install_id` or `device_key` is
/// refused before any request. `403 device_revoked` wipes that org. Redirects are never
/// followed; responses are JSON only, capped at 1 MiB, with a 15 s timeout.
///
/// - Cookies are never handled by URLSession (`httpShouldSetCookies = false`, no storage).
/// - Diagnostics name the method, path and status only; never a header value or body.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/OrgApiClient
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// └── MachineViewCore/SessionStore (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/OrgApiClient
/// ├── MachineView/AppServices (inferred)
/// └── MachineViewCoreTests/OrgApiClientTests (inferred)
/// <module-headers:end>
import Foundation

public final class OrgApiClient {
    public static let methods: Set<String> = ["GET", "POST", "PATCH", "DELETE"]
    public static let registrationPath = "/v1/me/devices"
    public static let maxRequestBytes = 64 * 1024
    public static let maxResponseBytes = 1024 * 1024
    public static let protocolVersion = "1"
    private static let pathRe = Pattern("/v1/[A-Za-z0-9/_.~%-]*(?:\\?[A-Za-z0-9=&_.~%-]*)?")

    private let session: URLSession
    private let orgs: OrgDirectory
    private let sessions: SessionStore
    private let installs: InstallIdStore
    private let deviceKeys: DeviceKeyStore
    private let userAgent: String
    private let cleaner: WebDataCleaner?
    private let diagnostics: DiagnosticsSink?
    private let clock: () -> Int64
    private let rung: CredentialKind

    public init(session: URLSession = OrgApiClient.makeSession(), orgs: OrgDirectory, sessions: SessionStore,
                installs: InstallIdStore, deviceKeys: DeviceKeyStore, userAgent: String, cleaner: WebDataCleaner?,
                diagnostics: DiagnosticsSink?, clock: @escaping () -> Int64, rung: CredentialKind = Fallbacks.credentialRung) {
        (self.session, self.orgs, self.sessions, self.installs, self.deviceKeys) = (session, orgs, sessions, installs, deviceKeys)
        (self.userAgent, self.cleaner, self.diagnostics, self.clock, self.rung) = (userAgent, cleaner, diagnostics, clock, rung)
    }

    /// Ephemeral, cookie-less, cache-less, 15 s, redirects refused.
    public static func makeSession(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 15
        if let protocolClasses { config.protocolClasses = protocolClasses }
        return URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
    }

    public func meta(orgUrl: String) async -> ApiResult {
        guard Pattern.orgUrl.matches(orgUrl), let url = URL(string: orgUrl + "/v1/meta") else { return .refused(.origin) }
        return await perform(baseRequest(url, method: "GET"), orgId: nil, registration: false)
    }

    public func request(orgId: String, method: String, path: String, body: Any?) async -> ApiResult {
        guard Self.methods.contains(method) else { return .refused(.method) }
        guard Self.pathRe.matches(path), !path.contains(".."), !path.contains("//") else { return .refused(.path) }
        guard let orgUrl = orgs.orgUrl(orgId), Pattern.orgUrl.matches(orgUrl), let url = URL(string: orgUrl + path),
              let controlHost = URL(string: orgUrl)?.host else { return .refused(.unknownOrg) }
        var bodyData: Data?
        if let body {
            guard JSONSerialization.isValidJSONObject([body]),
                  let data = try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]),
                  data.count <= Self.maxRequestBytes else { return .refused(.bodyInvalid) }
            bodyData = data
        }
        let registration = method == "POST" && path == Self.registrationPath
        let record = try? installs.get(orgId)
        if registration {
            guard let fields = body as? [String: Any] else { return .refused(.bodyInvalid) }
            guard let record, fields["install_id"] as? String == record.installId else { return .refused(.bodyInstallId) }
            guard let key = deviceKeys.publicKey(orgId), fields["device_key"] as? String == key else { return .refused(.bodyDeviceKey) }
        }
        guard let stored = try? sessions.get(controlHost), stored.exp > clock(),
              let cookie = try? CookieSpec.make(kind: rung, jwt: stored.jwt, cookie: stored.cookie) else { return .sessionExpired }
        var req = baseRequest(url, method: method)
        req.setValue("\(CookieSpec.name)=\(cookie.value)", forHTTPHeaderField: "Cookie")
        req.setValue(stored.jwt, forHTTPHeaderField: "cf-access-token")
        if let record, registration || record.registered { req.setValue(record.installId, forHTTPHeaderField: "Yaran-Install-Id") }
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let result = await perform(req, orgId: orgId, registration: registration)
        if registration, case .ok = result { try? installs.markRegistered(orgId) }
        return result
    }

    private func baseRequest(_ url: URL, method: String) -> URLRequest {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 15)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue(Self.protocolVersion, forHTTPHeaderField: "Yaran-Protocol")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    private func perform(_ req: URLRequest, orgId: String?, registration: Bool) async -> ApiResult {
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch let error as URLError {
            diagnostics?.append(diagLine("org api failed", [("path", req.url?.path ?? ""), ("urlerror", String(error.code.rawValue))]))
            return Self.isTls(error) ? .tlsError : .offline
        } catch {
            return .offline
        }
        guard let http = response as? HTTPURLResponse else { return .offline }
        diagnostics?.append(diagLine("org api", [("method", req.httpMethod ?? ""), ("path", req.url?.path ?? ""),
                                                 ("status", String(http.statusCode))]))
        // shortcut: the cap is checked after URLSession buffered the body; stream with bytes(for:) if 1 MiB ever matters.
        guard data.count <= Self.maxResponseBytes else { return .refused(.responseTooLarge) }
        return classify(status: http.statusCode, contentType: http.value(forHTTPHeaderField: "Content-Type"), data: data, orgId: orgId)
    }

    func classify(status: Int, contentType: String?, data: Data, orgId: String?) -> ApiResult {
        if (200..<300).contains(status) {
            if data.isEmpty { return .ok(status: status, body: nil) }
            guard contentType?.lowercased().hasPrefix("application/json") == true,
                  let body = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return .refused(.notJson) }
            return .ok(status: status, body: body)
        }
        if (300..<400).contains(status) { return .sessionExpired }
        guard let envelope = Self.envelope(data) else {
            if status == 401 || status == 403 { return .sessionExpired }
            return .apiError(status: status, error: [
                "error": ["code": status < 500 ? "bad_request" : "unavailable",
                          "message": "The server answered HTTP \(status) with no error details.", "retryable": status >= 500],
                "request_id": "-",
            ])
        }
        let error = envelope["error"] as! [String: Any]
        switch error["code"] as! String {
        case "device_revoked" where status == 403 && orgId != nil:
            try? sessions.wipe(orgId: orgId!, deviceKeys: deviceKeys, cleaner: cleaner)
            return .deviceRevoked
        case "protocol_unsupported":
            let details = error["details"] as? [String: Any]
            return .protocolUnsupported(min: SealedEnvelope.integer(details?["min"]).map(Int.init),
                                        max: SealedEnvelope.integer(details?["max"]).map(Int.init))
        default:
            return .apiError(status: status, error: envelope)
        }
    }

    /// The Phase 02 ErrorEnvelope when `data` is one.
    static func envelope(_ data: Data) -> [String: Any]? {
        guard let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let error = obj["error"] as? [String: Any], let code = error["code"] as? String, Pattern.errorCode.matches(code),
              error["message"] is String, error["retryable"] is Bool, obj["request_id"] is String else { return nil }
        return obj
    }

    static func isTls(_ e: URLError) -> Bool {
        switch e.code {
        case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted, .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired, .appTransportSecurityRequiresSecureConnection:
            return true
        default:
            return false
        }
    }
}

/// Hands every 3xx back as the final response instead of following it.
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
