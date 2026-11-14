/// The NSE and background-handler decision end to end: key selection by `r` across three
/// orgs, generic fallbacks, mutes, cleared events and the subscription store.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCoreTests/PushInboxTests
/// ├── YaranPushCore/Base64URL (inferred)
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// └── YaranPushCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import YaranPushCore

@Suite struct PushInboxTests {
    let store = PushSubscriptionStore(backend: InMemoryKeychain())
    let state = SharedPushState(defaults: UserDefaults(suiteName: "yaran.push.tests.\(UUID().uuidString)")!)
    let machine = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
    let now = Date(timeIntervalSince1970: 1_731_571_200)
    var inbox: PushInbox { PushInbox(subscriptions: store, state: state, builder: NotificationContentBuilder(localize: { $0.english })) }

    func subscribe(_ org: String) throws -> PushSubscription {
        let s = try store.mint(orgId: org)
        try store.save(s)
        state.setDirectory(OrgDirectory(orgName: org, machines: [machine: "box-\(org)"]), orgId: org)
        return s
    }

    func relayPush(_ json: String, to s: PushSubscription, alert: Bool = true) throws -> [AnyHashable: Any] {
        let body = try TestEncryptor.encrypt(Data(json.utf8), uaPublic: s.agreementKey().publicKey, authSecret: s.authSecret)
        let aps: [String: Any] = alert ? ["alert": ["title-loc-key": "PUSH_GENERIC_TITLE", "loc-key": "PUSH_GENERIC_BODY"], "mutable-content": 1] : ["content-available": 1]
        return ["aps": aps, "v": 1, "r": s.registrationId, "y": Base64URL.encode(body)]
    }

    let raised = #"{"v":1,"k":"attention_raised","m":"6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b","a":"agent-1","s":"needs_attention","p":"yaran","l":"fix the tests","ts":1731571200}"#
    let cleared = #"{"v":1,"k":"attention_cleared","m":"6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b","a":"agent-1","t":"t2","s":"idle","ts":1731571200}"#

    @Test func selectsTheOrgByRegistrationIdAmongThree() throws {
        let subs = try ["org-a", "org-b", "org-c"].map(subscribe)
        for s in subs {
            guard case let .show(content) = inbox.alertOutcome(userInfo: try relayPush(raised, to: s), now: now) else {
                Issue.record("no content for \(s.orgId)"); continue
            }
            #expect(content.userInfo["org"] == s.orgId)
            #expect(content.body == "yaran · box-\(s.orgId)")
        }
    }

    @Test func unknownRegistrationKeepsTheGenericAlert() throws {
        _ = try subscribe("org-a")
        let wrapping = try Fixtures.json("push/relay-wrapping.json")
        for c in wrapping["apns"] as! [[String: Any]] {
            #expect(inbox.alertOutcome(userInfo: c["payload"] as! [String: Any], now: now) == .keepGeneric(.unknownRegistration))
        }
    }

    @Test func corruptedCiphertextKeepsTheGenericAlert() throws {
        let s = try subscribe("org-a")
        var info = try relayPush(raised, to: s)
        var body = Base64URL.decode(info["y"] as! String)!
        body[body.count - 3] ^= 0x40
        info["y"] = Base64URL.encode(body)
        #expect(inbox.alertOutcome(userInfo: info, now: now) == .keepGeneric(.decryptFailed))
    }

    @Test func anotherOrgsKeysCannotDecrypt() throws {
        let a = try subscribe("org-a")
        let b = try subscribe("org-b")
        var info = try relayPush(raised, to: a)
        info["r"] = b.registrationId
        #expect(inbox.alertOutcome(userInfo: info, now: now) == .keepGeneric(.decryptFailed))
    }

    @Test func invalidPayloadAndNonRelayPush() throws {
        let s = try subscribe("org-a")
        #expect(inbox.alertOutcome(userInfo: try relayPush(#"{"v":2}"#, to: s), now: now) == .keepGeneric(.payloadInvalid))
        #expect(inbox.alertOutcome(userInfo: ["aps": [:]], now: now) == .keepGeneric(.notRelayPush))
    }

    @Test func mutedMachineIsPassive() throws {
        let s = try subscribe("org-a")
        state.setMutes(LocalMutes(mutedMachineIds: [machine]), orgId: "org-a")
        guard case let .show(content) = inbox.alertOutcome(userInfo: try relayPush(raised, to: s), now: now) else {
            Issue.record("expected content"); return
        }
        #expect(content.interruption == .passive)
    }

    @Test func clearedAlertIsPassiveOrSuppressed() throws {
        let s = try subscribe("org-a")
        guard case let .show(content) = inbox.alertOutcome(userInfo: try relayPush(cleared, to: s), now: now) else {
            Issue.record("expected content"); return
        }
        #expect(content.interruption == .passive)
        #expect(content.title == "An agent no longer needs you")
        state.filteringEnabled = true
        #expect(inbox.alertOutcome(userInfo: try relayPush(cleared, to: s), now: now) == .suppress)
    }

    @Test func backgroundClearNamesTheDeliveriesToRemove() throws {
        let s = try subscribe("org-a")
        let filter = try #require(inbox.clearFilter(userInfo: try relayPush(cleared, to: s, alert: false)))
        #expect(filter == DeliveredFilter(orgId: "org-a", machineId: machine, agentId: "agent-1", tab: .exactly("t2")))
        #expect(filter.matches(["org": "org-a", "machine": machine, "agent": "agent-1", "tab": "t2"]))
        #expect(filter.matches(["org": "org-a", "machine": machine, "agent": "agent-1"]) == false)
        #expect(filter.matches(["org": "org-b", "machine": machine, "agent": "agent-1", "tab": "t2"]) == false)
        #expect(inbox.clearFilter(userInfo: try relayPush(raised, to: s, alert: false)) == nil)
    }

    @Test func agentOpenFilterClearsEveryTab() {
        let filter = DeliveredFilter(orgId: "o", machineId: "m", agentId: "a", tab: .any)
        #expect(filter.matches(["org": "o", "machine": "m", "agent": "a", "tab": "t9"]))
        #expect(filter.matches(["org": "o", "machine": "m", "agent": "a"]))
        #expect(filter.matches(["org": "o", "machine": "m", "agent": "b"]) == false)
        #expect(DeliveredFilter(orgId: "o", machineId: "m", agentId: nil, tab: .any).matches(["org": "o", "machine": "m", "agent": "z"]))
    }

    @Test func storeRoundTripAndForget() throws {
        let minted = try store.mint(orgId: "org-x")
        #expect(try store.load(orgId: "org-x") == nil)
        try store.save(minted)
        #expect(try store.load(orgId: "org-x") == minted)
        #expect(try store.find(registrationId: minted.registrationId)?.orgId == "org-x")
        #expect(minted.authSecret.count == 16)
        #expect(try minted.p256dh().count == 87)
        try store.delete(orgId: "org-x")
        #expect(try store.find(registrationId: minted.registrationId) == nil)
    }

    @Test func sharedStateForget() {
        state.setMutes(LocalMutes(muteAll: true), orgId: "o")
        state.setDirectory(OrgDirectory(orgName: "O", machines: [:]), orgId: "o")
        state.forget(orgId: "o")
        #expect(state.mutes(orgId: "o") == LocalMutes())
        #expect(state.directory(orgId: "o") == nil)
    }
}
