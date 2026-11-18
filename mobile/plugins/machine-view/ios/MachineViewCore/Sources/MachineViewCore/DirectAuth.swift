/// The direct-machine HTTP client (G1, G2): status probe, `cli-login`, `cli-logout`, and the
/// org route probe. The Swift twin of `DirectAuth.kt` plus `DirectFlow.orgRouteStatus`.
///
/// Every request goes to `https://<host>/` on the default port through an ephemeral session
/// that keeps no cookies and follows no redirect (`NoRedirects`): a 3xx is classified, never
/// followed. A stored session is attached only to its own host, and only after an
/// unauthenticated answer proved the host is a yaran with the instance the session was issued
/// by. An org route carries only its own host's `CF_Authorization`, from a session of its own
/// org. A token the phone could not keep is revoked at once.
///
/// - Diagnostics name the host and the error type only.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/DirectAuth
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// └── MachineViewCore/SessionStore (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/DirectAuth
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// └── MachineViewCoreTests/DirectTests (inferred)
/// <module-headers:end>
import Foundation

public final class DirectAuth {
    private let session: URLSession
    private let userAgent: String
    private let diagnostics: DiagnosticsSink?

    public init(session: URLSession = OrgApiClient.makeSession(), userAgent: String, diagnostics: DiagnosticsSink?) {
        (self.session, self.userAgent, self.diagnostics) = (session, userAgent, diagnostics)
    }

    /// A route probe's deadline: a tailnet name answers fast or not at all.
    public static func probeTimeout(_ host: String) -> TimeInterval { host.hasSuffix(".ts.net") ? 3 : 8 }

    private enum Sent { case answer(status: Int, location: String?, contentType: String?, body: Data), tooLarge, tls, offline }

    /// The public status document; with `stored`, also whether that session is signed in there.
    /// The session is sent only when it is bound to the instance that just answered, and that is
    /// the `expected` one when a window recorded one: an unbound (older) session or another
    /// instance never sees the token. Instance ids are public: a consistency check, never authorization.
    public func status(host: String, stored: DirectSession?, timeout: TimeInterval = 15, expected: String? = nil) async -> DirectStatus {
        guard DirectWire.isPublicHost(host) else { return .refused(reason: "invalid_host") }
        let open = await get(host: host, cookie: nil, timeout: timeout)
        guard case let .yaran(instance, _, _, _, _) = open, let stored, stored.host == host,
              stored.bound(to: instance), expected == nil || expected == instance,
              let cookie = stored.setCookie?.components(separatedBy: ";").first else { return open }
        // The newer answer, as classified (another instance, too old, offline, a refusal): never
        // swapped for the public one it followed, so the caller's mismatch or upgrade verdict holds.
        return await get(host: host, cookie: cookie, timeout: timeout)
    }

    public func get(host: String, cookie: String?, timeout: TimeInterval = 15) async -> DirectStatus {
        switch await send(host: host, path: DirectWire.statusPath, method: "GET", body: nil, cookie: cookie, bearer: nil, timeout: timeout) {
        case let .answer(status, location, contentType, body):
            return DirectWire.classifyStatus(status: status, location: location, contentType: contentType, body: body)
        case .tooLarge: return .refused(reason: "response_too_large")
        case .tls: return .tlsError
        case .offline: return .offline
        }
    }

    public func login(host: String, body: Data) async -> LoginAnswer {
        let answer: LoginAnswer
        switch await send(host: host, path: DirectWire.loginPath, method: "POST", body: body, cookie: nil, bearer: nil, timeout: 15) {
        case let .answer(status, location, contentType, data):
            answer = DirectWire.classifyLogin(status: status, location: location, contentType: contentType, body: data)
        case .tooLarge: answer = .failed(.refused(reason: "response_too_large"), revoke: nil)
        case .tls: answer = .failed(.tlsError, revoke: nil)
        case .offline: answer = .failed(.offline, revoke: nil)
        }
        if case .failed(_, let revoke?) = answer { _ = await logout(host: host, token: revoke) }
        return answer
    }

    /// Ends `token` on the machine; true only when it answered 204. Best effort.
    public func logout(host: String, token: String) async -> Bool {
        guard DirectWire.isPublicHost(host), DirectWire.token.matches(token) else { return false }
        if case .answer(204, _, _, _) = await send(host: host, path: DirectWire.logoutPath, method: "POST", body: Data(), cookie: nil,
                                                   bearer: "Bearer \(token)", timeout: 15) {
            return true
        }
        return false
    }

    /// An org route's status with only its own session, nil meaning `sign_in_required`.
    public func orgRouteStatus(orgId: String, host: String, sessions: SessionStore, now: Int64,
                               timeout: TimeInterval = 15) async throws -> DirectStatus? {
        let stored: StoredSession?
        do { stored = try sessions.get(host) } catch VaultError.locked { throw VaultError.locked } catch {
            diagnostics?.append(diagLine("org session unreadable", [("host", host)]))
            stored = nil
        }
        guard let stored, stored.orgId == orgId, stored.exp > now,
              let cookie = try? CookieSpec.make(kind: stored.credentialKind, jwt: stored.jwt, cookie: stored.cookie) else { return nil }
        let status = await get(host: host, cookie: "\(CookieSpec.name)=\(cookie.value)", timeout: timeout)
        switch status {
        case .accessRequired, .redirected: return nil
        default: return status
        }
    }

    // One request primitive for status, login and logout; each argument is one request field.
    // swiftlint:disable:next function_parameter_count
    private func send(host: String, path: String, method: String, body: Data?, cookie: String?, bearer: String?,
                      timeout: TimeInterval) async -> Sent {
        guard let url = URL(string: "https://\(host)\(path)") else { return .offline }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let cookie { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        if let bearer { req.setValue(bearer, forHTTPHeaderField: "Authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return .offline }
            // shortcut: the cap is checked after URLSession buffered the body, as OrgApiClient does.
            if data.count > 64 * 1024 { return .tooLarge }
            return .answer(status: http.statusCode, location: http.value(forHTTPHeaderField: "Location"),
                           contentType: http.value(forHTTPHeaderField: "Content-Type"), body: data)
        } catch let error as URLError {
            diagnostics?.append(diagLine(OrgApiClient.isTls(error) ? "direct tls error" : "direct offline", [("host", host)]))
            return OrgApiClient.isTls(error) ? .tls : .offline
        } catch {
            diagnostics?.append(diagLine("direct offline", [("host", host)]))
            return .offline
        }
    }
}
