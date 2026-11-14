/// Tests for the native org API client against a `URLProtocol` stub.
///
/// Both credential headers, the UA and protocol headers, `Yaran-Install-Id` before, on and
/// after registration, foreign `install_id`/`device_key` refused with no request, every
/// `ApiResult` variant, the size cap, path/method/origin refusal, no redirect following, and
/// a `device_revoked` wipe that leaves another org untouched.
///
/// - Serialized: the stub's handler and request log are process-global.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/OrgApiClientTests
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (URLRequest) -> (Int, [String: String], Data) = { _ in (200, [:], Data()) }
    nonisolated(unsafe) static var error: URLError?
    nonisolated(unsafe) static var requests: [(URLRequest, Data?)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        var body: Data?
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(), buf = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; data.append(buf, count: n) }
            body = data
        }
        Self.requests.append((request, body ?? request.httpBody))
        if let error = Self.error { client?.urlProtocol(self, didFailWithError: error); return }
        let (status, headers, data) = Self.handler(request)
        let resp = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class ApiRig {
    let store = StoreRig(), orgs = FakeOrgs()
    var now: Int64 = 1_000_000
    lazy var client = OrgApiClient(session: OrgApiClient.makeSession(protocolClasses: [StubProtocol.self]), orgs: orgs,
                                   sessions: store.sessions(), installs: store.installs, deviceKeys: store.keys,
                                   userAgent: "YaranApp/1.2.3 (ios; phone)", cleaner: store.cleaner, diagnostics: store.diag,
                                   clock: { [unowned self] in self.now })
    init(signedIn: Bool = true) {
        StubProtocol.requests = []; StubProtocol.error = nil
        StubProtocol.handler = { _ in (200, ["Content-Type": "application/json"], Data("{\"ok\":true}".utf8)) }
        if signedIn {
            try! store.sessions().put(orgId: "org-a", payload: payload(host: "cp.example.com", exp: now + 3600, kind: "control_plane"),
                                      kind: .accessJwt)
        }
    }
    func json(_ status: Int, _ obj: Any) { StubProtocol.handler = { _ in (status, ["Content-Type": "application/json"], try! JSONSerialization.data(withJSONObject: obj)) } }
    func envelope(_ status: Int, _ code: String, details: [String: Any]? = nil) {
        var error: [String: Any] = ["code": code, "message": "m", "retryable": false]
        if let details { error["details"] = details }
        json(status, ["error": error, "request_id": "r1"])
    }
    var last: URLRequest { StubProtocol.requests.last!.0 }
}

@Suite(.serialized) struct OrgApiClientTests {
    @Test func sendsBothCredentialsAndTheProtocolHeaders() async throws {
        let r = ApiRig()
        let res = await r.client.request(orgId: "org-a", method: "GET", path: "/v1/machines", body: nil)
        guard case .ok(200, let body) = res else { Issue.record("got \(res.kind)"); return }
        #expect((body as? [String: Bool])?["ok"] == true)
        let jwt = try r.store.sessions().get("cp.example.com")!.jwt
        #expect(r.last.url?.absoluteString == "https://cp.example.com/v1/machines")
        #expect(r.last.value(forHTTPHeaderField: "Cookie") == "CF_Authorization=\(jwt)")
        #expect(r.last.value(forHTTPHeaderField: "cf-access-token") == jwt)
        #expect(r.last.value(forHTTPHeaderField: "User-Agent") == "YaranApp/1.2.3 (ios; phone)")
        #expect(r.last.value(forHTTPHeaderField: "Yaran-Protocol") == "1")
        #expect(r.last.value(forHTTPHeaderField: "Yaran-Install-Id") == nil)
        #expect(expectClean(r.store.diag.lines, [jwt]))
    }

    @Test func installIdHeaderOnRegistrationAndAfter() async throws {
        let r = ApiRig()
        let id = try r.store.keys.ensure("org-a")
        let body: [String: Any] = ["install_id": id.installId, "device_key": id.publicKey, "label": "x"]
        _ = await r.client.request(orgId: "org-a", method: "POST", path: "/v1/me/devices", body: body)
        #expect(r.last.value(forHTTPHeaderField: "Yaran-Install-Id") == id.installId)
        let sent = try JSONSerialization.jsonObject(with: StubProtocol.requests.last!.1!) as! [String: Any]
        #expect(sent["install_id"] as? String == id.installId)
        #expect(try r.store.installs.get("org-a")?.registered == true)
        _ = await r.client.request(orgId: "org-a", method: "PATCH", path: "/v1/me/devices/\(id.installId)", body: ["mute_all": true])
        #expect(r.last.value(forHTTPHeaderField: "Yaran-Install-Id") == id.installId)
    }

    @Test func foreignRegistrationBodiesAreRefusedWithoutARequest() async throws {
        let r = ApiRig()
        let id = try r.store.keys.ensure("org-a")
        let otherKey = B64url.encode(SoftwareKeyBackend().keys["x", default: .init()].publicKey.x963Representation)
        let a = await r.client.request(orgId: "org-a", method: "POST", path: "/v1/me/devices",
                                       body: ["install_id": UUID().uuidString.lowercased(), "device_key": id.publicKey])
        let b = await r.client.request(orgId: "org-a", method: "POST", path: "/v1/me/devices",
                                       body: ["install_id": id.installId, "device_key": otherKey])
        #expect(a.jsObject["reason"] as? String == "body_install_id" && b.jsObject["reason"] as? String == "body_device_key")
        #expect(StubProtocol.requests.isEmpty)
    }

    @Test func refusalsBeforeAnyRequest() async {
        let r = ApiRig()
        for (method, path, org, reason) in [("PUT", "/v1/x", "org-a", "method"), ("GET", "/v2/x", "org-a", "path"),
                                            ("GET", "/v1/../admin", "org-a", "path"), ("GET", "/v1//x", "org-a", "path"),
                                            ("GET", "https://evil.example/v1/x", "org-a", "path"), ("GET", "/v1/x", "nope", "unknown_org")] {
            let res = await r.client.request(orgId: org, method: method, path: path, body: nil)
            #expect(res.jsObject["reason"] as? String == reason, "\(method) \(path)")
        }
        r.orgs.urls["org-c"] = "http://cp.example.com"
        #expect(await r.client.request(orgId: "org-c", method: "GET", path: "/v1/x", body: nil).jsObject["reason"] as? String == "unknown_org")
        #expect(StubProtocol.requests.isEmpty)
    }

    @Test func missingOrExpiredSessionIsSessionExpiredWithoutARequest() async {
        let r = ApiRig(signedIn: false)
        #expect(await r.client.request(orgId: "org-a", method: "GET", path: "/v1/x", body: nil).kind == "session_expired")
        let s = ApiRig()
        s.now += 3600
        #expect(await s.client.request(orgId: "org-a", method: "GET", path: "/v1/x", body: nil).kind == "session_expired")
        #expect(StubProtocol.requests.isEmpty)
    }

    @Test func resultVariants() async {
        let r = ApiRig()
        func kind() async -> ApiResult { await r.client.request(orgId: "org-a", method: "GET", path: "/v1/x", body: nil) }
        r.envelope(404, "not_found")
        guard case .apiError(404, let env) = await kind() else { Issue.record("api_error"); return }
        #expect((env["error"] as? [String: Any])?["code"] as? String == "not_found")
        r.envelope(400, "protocol_unsupported", details: ["min": 2, "max": 3])
        #expect(await kind().jsObject as NSDictionary == ["kind": "protocol_unsupported", "min": 2, "max": 3])
        StubProtocol.handler = { _ in (401, [:], Data("<html>".utf8)) }
        #expect(await kind().kind == "session_expired")
        StubProtocol.handler = { _ in (302, ["Location": "https://team.cloudflareaccess.com/"], Data()) }
        #expect(await kind().kind == "session_expired")
        #expect(StubProtocol.requests.last!.0.url?.host == "cp.example.com")
        StubProtocol.handler = { _ in (502, [:], Data("bad gateway".utf8)) }
        guard case .apiError(502, let synth) = await kind() else { Issue.record("synth"); return }
        #expect((synth["error"] as? [String: Any])?["code"] as? String == "unavailable")
        StubProtocol.handler = { _ in (200, ["Content-Type": "text/html"], Data("<html>".utf8)) }
        #expect(await kind().jsObject["reason"] as? String == "not_json")
        StubProtocol.handler = { _ in (204, [:], Data()) }
        guard case .ok(204, nil) = await kind() else { Issue.record("204"); return }
        StubProtocol.handler = { _ in (200, ["Content-Type": "application/json"], Data(repeating: 0x20, count: 1024 * 1024 + 1)) }
        #expect(await kind().jsObject["reason"] as? String == "response_too_large")
        StubProtocol.error = URLError(.notConnectedToInternet)
        #expect(await kind().kind == "offline")
        StubProtocol.error = URLError(.serverCertificateUntrusted)
        #expect(await kind().kind == "tls_error")
    }

    @Test func deviceRevokedWipesOnlyThatOrg() async throws {
        let r = ApiRig()
        try r.store.keys.ensure("org-a"); try r.store.keys.ensure("org-b")
        try r.store.sessions().put(orgId: "org-a", payload: payload(host: "m1.example.com", exp: r.now + 99), kind: .accessJwt)
        try r.store.sessions().put(orgId: "org-b", payload: payload(host: "cp-b.example.com", exp: r.now + 99), kind: .accessJwt)
        r.envelope(403, "device_revoked")
        #expect(await r.client.request(orgId: "org-a", method: "GET", path: "/v1/me", body: nil).kind == "device_revoked")
        #expect(try r.store.sessions().hosts(orgId: "org-a").isEmpty)
        #expect(try r.store.installs.get("org-a") == nil && r.store.keys.publicKey("org-a") == nil)
        #expect(try r.store.sessions().hosts(orgId: "org-b") == ["cp-b.example.com"])
        #expect(try r.store.installs.get("org-b") != nil)
        #expect(r.store.cleaner.cleared == [["cp.example.com", "m1.example.com"]])
    }

    @Test func metaIsPublicAndOnlyMeta() async {
        let r = ApiRig()
        r.json(200, ["name": "Ada"])
        guard case .ok = await r.client.meta(orgUrl: "https://cp.example.com") else { Issue.record("meta"); return }
        #expect(r.last.url?.absoluteString == "https://cp.example.com/v1/meta")
        #expect(r.last.value(forHTTPHeaderField: "Cookie") == nil && r.last.value(forHTTPHeaderField: "cf-access-token") == nil)
        #expect(await r.client.meta(orgUrl: "https://cp.example.com/evil").jsObject["reason"] as? String == "origin")
    }
}
