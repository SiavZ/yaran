/// The relay client, the W12 registration body and the foreground policy, against 02's
/// schemas and fixtures, a stub `URLProtocol` and a fake of Phase 15's org client.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushRegistrationTests/RegistrationTests
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// ├── YaranPushRegistration/PresentationPolicy (inferred)
/// ├── YaranPushRegistration/RelayEndpointClient (inferred)
/// └── YaranPushRegistrationTests/StubURLProtocol (inferred)
/// External: Foundation, Testing, UserNotifications
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
import UserNotifications
import YaranPushCore
@testable import YaranPushRegistration

private let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("cloud/protocol")

private func load(_ path: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent(path))) as! [String: Any]
}

private let vapid = "BGuXrBERTW6sUC8-SWAenyGmbmQg3GyikfpRKoD9PWtulg4KijYaQ6d6wd5EVYTC12m3K0K5IRf66r20urk2rG0"
private let token = String(repeating: "ab", count: 32)
private let app = AppInfo(bundleId: "com.example.yaran", flavor: "appstore", appVersion: "1.0.0", formFactor: "phone", apnsEnvironment: "production")
private let meta: [String: Any] = ["service": "yaran-push-relay", "protocol": ["min": 1, "max": 1], "apps": ["com.example.yaran"], "channels": ["apns"], "endpoint_key_id": "k1"]
private let endpoint = "https://relay.example.com/w/v1.k1.AAAAAAAAAAAAAAAAAAAAAAAA"

private func relayHandler(meta: [String: Any] = meta, mint: (Int, [String: String], Data) = (201, [:], json(["endpoint": endpoint]))) {
    StubURLProtocol.handler = { request in
        request.url!.path.hasSuffix("/v1/meta") ? (200, [:], json(meta)) : mint
    }
}

/// Both stubbed suites share `StubURLProtocol`, so they run one test at a time.
@Suite(.serialized) enum RelayStubbed {}

extension RelayStubbed {
@Suite struct RelayEndpointClientTests {
    func client() throws -> RelayEndpointClient {
        try RelayEndpointClient(baseURL: URL(string: "https://relay.example.com")!, appId: "com.example.yaran", session: StubURLProtocol.session())
    }

    @Test func refusesNonHttpsBeforeAnyRequest() {
        StubURLProtocol.requests = []
        #expect(throws: RelayError.insecureBaseURL) {
            try RelayEndpointClient(baseURL: URL(string: "http://relay.example.com")!, appId: "a")
        }
        #expect(StubURLProtocol.requests.isEmpty)
    }

    @Test func mintsWithTheExact02Body() async throws {
        relayHandler()
        let c = try client()
        #expect(try await c.endpointKeyId(channel: .apns) == "k1")
        let fixture = (try load("fixtures/api/ApnsMintRequest.json")["valid"] as! [[String: Any]])[0]["value"] as! [String: String]
        let body = c.apnsMintBody(token: token, environment: "production", vapidPublicKey: vapid, registrationId: "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b")
        #expect(body == fixture)
        #expect(try await c.mint(body: body) == endpoint)
        let sent = try JSONSerialization.jsonObject(with: StubURLProtocol.requests.last!.httpBody!) as! [String: String]
        #expect(sent == fixture)
        #expect(StubURLProtocol.requests.last!.httpMethod == "POST")
    }

    @Test func metaMismatchesAreRefused() async throws {
        var other = meta
        other["apps"] = ["com.other.app"]
        relayHandler(meta: other)
        await #expect(throws: RelayError.appNotServed) { try await client().endpointKeyId(channel: .apns) }
        other = meta
        other["channels"] = ["fcm"]
        relayHandler(meta: other)
        await #expect(throws: RelayError.channelNotServed) { try await client().endpointKeyId(channel: .apns) }
        other["service"] = "something-else"
        relayHandler(meta: other)
        await #expect(throws: RelayError.notYaranRelay) { try await client().endpointKeyId(channel: .apns) }
    }

    @Test func errorAnswers() async throws {
        let body = ["k": "v"]
        relayHandler(mint: (429, ["Retry-After": "30"], Data()))
        await #expect(throws: RelayError.rateLimited(retryAfter: 30)) { try await client().mint(body: body) }
        relayHandler(mint: (503, [:], Data()))
        await #expect(throws: RelayError.unavailable(status: 503)) { try await client().mint(body: body) }
        relayHandler(mint: (500, [:], Data("oops".utf8)))
        await #expect(throws: RelayError.unavailable(status: 500)) { try await client().mint(body: body) }
        relayHandler(mint: (400, [:], json(["error": ["code": "relay_app_unknown", "message": "x", "retryable": false], "request_id": "r"])))
        await #expect(throws: RelayError.api(status: 400, code: "relay_app_unknown")) { try await client().mint(body: body) }
        relayHandler(mint: (201, [:], json(["endpoint": "https://evil.example/elsewhere"])))
        await #expect(throws: RelayError.malformedResponse) { try await client().mint(body: body) }
    }
}

@Suite struct DeviceRegistrarTests {
    let store = PushSubscriptionStore(backend: InMemoryKeychain())
    let api = FakeOrgApi()

    func registrar() throws -> DeviceRegistrar {
        let relay = try RelayEndpointClient(baseURL: URL(string: "https://relay.example.com")!, appId: app.bundleId, session: StubURLProtocol.session())
        return DeviceRegistrar(subscriptions: store, relay: relay, gateway: api, app: app)
    }

    func request(pushOff: Bool = false, vapid: String? = vapid) -> RegisterRequest {
        RegisterRequest(orgId: "org-1", installId: "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d", label: "Ada's iPhone", locale: "en-GB",
                        mutes: LocalMutes(mutedUntil: Date(timeIntervalSince1970: 1_731_571_200), mutedMachineIds: ["3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b"]),
                        pushOff: pushOff, vapidPublicKey: vapid)
    }

    /// The body has exactly 02's `DeviceRegistration` fields and the schema's id patterns.
    func assertMatchesSchema(_ body: [String: Any]) throws {
        let defs = try load("schemas/devices.schema.json")["$defs"] as! [String: Any]
        let registration = defs["DeviceRegistration"] as! [String: Any]
        let required = Set(registration["required"] as! [String])
        let allowed = Set((registration["properties"] as! [String: Any]).keys)
        #expect(required.isSubset(of: Set(body.keys)))
        #expect(Set(body.keys).isSubset(of: allowed))
        #expect(body["muted_until"] as? String == "2024-11-14T08:00:00Z")
        let push = body["push"] as! [String: Any]
        if push["kind"] as? String == "webpush" {
            let keys = push["keys"] as! [String: String]
            #expect(keys["p256dh"]!.range(of: "^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$", options: .regularExpression) != nil)
            #expect(keys["auth"]!.range(of: "^[A-Za-z0-9_-]{21}[AQgw]$", options: .regularExpression) != nil)
            #expect(Set(push.keys) == ["kind", "channel", "endpoint", "keys"])
        } else {
            #expect(Set(push.keys) == ["kind"])
        }
    }

    @Test func registersWithEndpointAndDeviceKey() async throws {
        relayHandler()
        let outcome = await try registrar().register(request(), apnsToken: token)
        guard case .ok = outcome else { Issue.record("\(outcome)"); return }
        let body = try #require(api.bodies.last)
        try assertMatchesSchema(body)
        #expect(body["device_key"] as? String == api.deviceKey)
        #expect(body["platform"] as? String == "ios")
        #expect((body["push"] as! [String: Any])["endpoint"] as? String == endpoint)
        #expect((body["push"] as! [String: Any])["channel"] as? String == "apns_relay")
        #expect(try store.load(orgId: "org-1")?.endpointKeyId == "k1")
    }

    @Test func pushOffSendsNoneWithTheSameDeviceKeyAndForgetsKeys() async throws {
        relayHandler()
        _ = await try registrar().register(request(), apnsToken: token)
        let outcome = await try registrar().register(request(pushOff: true), apnsToken: nil)
        guard case .ok = outcome else { Issue.record("\(outcome)"); return }
        let body = try #require(api.bodies.last)
        try assertMatchesSchema(body)
        #expect((body["push"] as! [String: Any])["kind"] as? String == "none")
        #expect(body["device_key"] as? String == api.deviceKey)
        #expect(try store.load(orgId: "org-1") == nil)
    }

    @Test func reusesTheEndpointUntilVapidOrKidChanges() async throws {
        relayHandler()
        _ = await try registrar().register(request(), apnsToken: token)
        let first = try #require(try store.load(orgId: "org-1"))
        _ = await try registrar().register(request(), apnsToken: token)
        #expect(try store.load(orgId: "org-1") == first)
        let rotated = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        _ = await try registrar().register(request(vapid: rotated), apnsToken: token)
        let second = try #require(try store.load(orgId: "org-1"))
        #expect(second.registrationId != first.registrationId)
        #expect(second.vapidPublicKey == rotated)
        var newKid = meta
        newKid["endpoint_key_id"] = "k2"
        relayHandler(meta: newKid)
        _ = await try registrar().register(request(vapid: rotated), apnsToken: token)
        #expect(try store.load(orgId: "org-1")?.endpointKeyId == "k2")
        _ = await try registrar().register(request(vapid: rotated), apnsToken: String(repeating: "cd", count: 32))
        #expect(try store.load(orgId: "org-1")?.transportToken == String(repeating: "cd", count: 32))
    }

    @Test func failedMintKeepsTheWorkingSubscription() async throws {
        relayHandler()
        _ = await try registrar().register(request(), apnsToken: token)
        let first = try store.load(orgId: "org-1")
        relayHandler(mint: (503, [:], Data()))
        let rotated = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        let outcome = await try registrar().register(request(vapid: rotated), apnsToken: token)
        #expect(outcome == .pushUnavailable(reason: "the push relay is unavailable (HTTP 503)"))
        #expect(try store.load(orgId: "org-1") == first)
    }

    @Test func outcomesThatNeverReachTheWorker() async throws {
        relayHandler()
        #expect(await try registrar().register(request(), apnsToken: nil) == .needsPermission)
        #expect(await try registrar().register(request(vapid: nil), apnsToken: token) == .pushUnavailable(reason: "push is turned off for this organization"))
        #expect(api.bodies.isEmpty)
    }

    @Test func deviceRevokedIsSurfacedAndForgetsKeys() async throws {
        relayHandler()
        api.result = .deviceRevoked
        #expect(await try registrar().register(request(), apnsToken: token) == .api(.deviceRevoked))
        #expect(try store.load(orgId: "org-1") == nil)
    }
}
}

@Suite struct PresentationPolicyTests {
    let info: [AnyHashable: Any] = ["org": "o", "machine": "m", "agent": "a", "tab": "t"]

    @Test func suppressesOnlyTheVisibleAgentTab() {
        #expect(PresentationPolicy.foregroundOptions(userInfo: info, visible: VisibleAgent(orgId: "o", machineId: "m", agentId: "a", tabId: "t")) == [])
        #expect(PresentationPolicy.foregroundOptions(userInfo: info, visible: VisibleAgent(orgId: "o", machineId: "m", agentId: "a", tabId: nil)) == [.banner, .list, .sound])
        #expect(PresentationPolicy.foregroundOptions(userInfo: info, visible: nil) == [.banner, .list, .sound])
    }

    @Test func oneCategoryWithTheForegroundMuteAction() throws {
        let categories = PresentationPolicy.categories(muteTitle: "Mute this machine")
        let category = try #require(categories.first)
        #expect(categories.count == 1)
        #expect(category.identifier == NotificationContentBuilder.agentCategory)
        #expect(category.actions.map(\.identifier) == [NotificationContentBuilder.muteMachineAction])
        #expect(category.actions.first?.options.contains(.foreground) == true)
    }

    @Test func tapEventCarriesIdsOnly() throws {
        let tap = try #require(TapEvent(userInfo: info, actionIdentifier: UNNotificationDefaultActionIdentifier))
        #expect(tap.dictionary as NSDictionary == ["orgId": "o", "machineId": "m", "agentId": "a", "tabId": "t", "action": "open"] as NSDictionary)
        let mute = try #require(TapEvent(userInfo: info, actionIdentifier: NotificationContentBuilder.muteMachineAction))
        #expect(mute.action == .muteMachine)
        #expect(TapEvent(userInfo: ["machine": "m"], actionIdentifier: "x") == nil)
    }
}
