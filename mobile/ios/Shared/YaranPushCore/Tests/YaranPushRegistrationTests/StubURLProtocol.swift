/// Test support: a `URLProtocol` stub for the relay client and a fake of Phase 15's org client.
///
/// - The stub answers from one handler per test; suites using it run `.serialized`.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushRegistrationTests/StubURLProtocol
/// └── YaranPushRegistration/OrgApiGateway (inferred)
/// External: Foundation
///
/// Used by:
/// YaranPushRegistrationTests/StubURLProtocol
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation
import YaranPushRegistration

final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        requests = []
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = self.request
        if request.httpBody == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            request.httpBody = data
        }
        Self.requests.append(request)
        let (status, headers, body) = Self.handler?(request) ?? (500, [:], Data())
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class FakeOrgApi: OrgApiGateway, @unchecked Sendable {
    var deviceKey = "BGuXrBERTW6sUC8-SWAenyGmbmQg3GyikfpRKoD9PWtulg4KijYaQ6d6wd5EVYTC12m3K0K5IRf66r20urk2rG0"
    var result: OrgApiResult = .ok(status: 201, body: Data(#"{"id":"c0ffee00-1234-4abc-bdef-0123456789ab"}"#.utf8))
    var bodies: [[String: Any]] = []

    func devicePublicKey(orgId: String) async throws -> String { deviceKey }

    func registerDevice(orgId: String, body: Data) async -> OrgApiResult {
        bodies.append(try! JSONSerialization.jsonObject(with: body) as! [String: Any])
        return result
    }
}

func json(_ object: Any) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
}
