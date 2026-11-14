/// The device-side payload parse, the topic and display sanitizing, pinned to 02's
/// `push/payload-parse.json`, `push/payload-events.json` and `push/payload-topic.json`.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCoreTests/PushPayloadTests
/// ├── YaranPushCore/PushPayload (inferred)
/// ├── YaranPushCore/PushTopic (inferred)
/// └── YaranPushCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
@testable import YaranPushCore

@Suite struct PushPayloadTests {
    @Test func parseFixture() throws {
        let cases = try Fixtures.json("push/payload-parse.json")["cases"] as! [[String: Any]]
        for c in cases {
            let parsed = PushPayload.parse(Data((c["utf8"] as! String).utf8))
            let expectOk = c["expect"] as! String == "ok"
            #expect((parsed != nil) == expectOk, "\(c["name"]!)")
        }
    }

    @Test func everyEventFixtureParsesToItsFields() throws {
        let cases = try Fixtures.json("push/payload-events.json")["cases"] as! [[String: Any]]
        #expect(cases.count >= 18)
        for c in cases {
            let expected = c["payload"] as! [String: Any]
            let parsed = try #require(PushPayload.parse(Data((c["serialized"] as! String).utf8)), "\(c["name"]!)")
            let push = try #require(parsed.agent)
            #expect(push.machineId == expected["m"] as? String)
            #expect(push.agentId == expected["a"] as? String)
            #expect(push.tabId == expected["t"] as? String)
            #expect(push.token == expected["s"] as? String)
            #expect(push.project == expected["p"] as? String)
            #expect(push.label == expected["l"] as? String)
            let kind: String = switch parsed {
            case .attentionRaised: "attention_raised"
            case .attentionCleared: "attention_cleared"
            case .agentExitedBadly: "agent_exited_badly"
            case .test: "test"
            }
            #expect(kind == expected["k"] as? String)
        }
    }

    @Test func strictnessBeyondTheFixture() {
        let base = #"{"v":1,"k":"attention_raised","m":"6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b","a":"x","s":"needs_attention","ts":1"#
        #expect(PushPayload.parse(Data((base + "}").utf8)) != nil)
        #expect(PushPayload.parse(Data((base + #","t":null}"#).utf8)) == nil)
        #expect(PushPayload.parse(Data((base + #","p":""}"#).utf8)) == nil)
        let noToken = #"{"v":1,"k":"attention_raised","m":"6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b","a":"x","ts":1,"s":"needs_attention\n"}"#
        #expect(PushPayload.parse(Data(noToken.utf8)) == nil)
        #expect(PushPayload.parse(Data(#"{"v":true,"k":"test","ts":1}"#.utf8)) == nil)
        #expect(PushPayload.parse(Data(#"{"v":1,"k":"test","ts":1.5}"#.utf8)) == nil)
        #expect(PushPayload.parse(Data(#"{"v":1,"k":"test","ts":-1}"#.utf8)) == nil)
        #expect(PushPayload.parse(Data([0xff, 0xfe])) == nil)
        #expect(PushPayload.parse(Data(#"{"v":1,"k":"attention_raised","m":"6F1C2A9E-3B4D-4E5F-8A7B-9C0D1E2F3A4B","a":"x","s":"x","ts":1}"#.utf8)) == nil)
    }

    @Test func topicFixture() throws {
        let topics = try Fixtures.json("push/payload-topic.json")["topics"] as! [[String: Any]]
        for t in topics {
            let tab = t["t"] as? String
            #expect(PushTopic.topic(machineId: t["m"] as! String, agentId: t["a"] as! String, tabId: tab) == t["topic"] as! String)
        }
    }

    @Test func twoAgentsSlotTabsOnOneMachineDiffer() {
        let m = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
        #expect(PushTopic.topic(machineId: m, agentId: "a1", tabId: nil) != PushTopic.topic(machineId: m, agentId: "a2", tabId: nil))
    }

    @Test func displayStripsControlAndBidi() {
        #expect(PushText.display("fix\u{202E}gnp.exe") == "fixgnp.exe")
        #expect(PushText.display("a\u{1B}[31mb\u{07}") == "a[31mb")
        #expect(PushText.display("\u{2066}x\u{2069} ") == "x")
        #expect(PushText.display("日本語") == "日本語")
    }

    @Test func relayWrappingFromTheFixture() throws {
        let wrapping = try Fixtures.json("push/relay-wrapping.json")
        for c in wrapping["apns"] as! [[String: Any]] {
            let relay = try #require(RelayWrapping(userInfo: c["payload"] as! [String: Any]))
            #expect(relay.registrationId == wrapping["registration_id"] as! String)
            #expect(relay.body == Fixtures.b64(wrapping["body_b64url"]))
        }
        #expect(RelayWrapping(userInfo: ["v": 2, "r": wrapping["registration_id"]!, "y": "AA"]) == nil)
        #expect(RelayWrapping(userInfo: ["v": 1, "r": "nope", "y": "AA"]) == nil)
        #expect(RelayWrapping(userInfo: ["v": 1, "r": wrapping["registration_id"]!, "y": "A+/="]) == nil)
    }
}
