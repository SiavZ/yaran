/// Notification wording and shape for every payload kind and token, mutes and omitted fields.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCoreTests/NotificationContentTests
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushPayload (inferred)
/// └── YaranPushCore/SharedPushState (inferred)
/// External: Foundation, Testing, UserNotifications
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import Foundation
import Testing
import UserNotifications
@testable import YaranPushCore

@Suite struct NotificationContentTests {
    let builder = NotificationContentBuilder(localize: { $0.english })
    let machine = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b"
    var directory: OrgDirectory { OrgDirectory(orgName: "Acme", machines: [machine: "build-box"]) }
    let now = Date(timeIntervalSince1970: 1_731_571_200)

    func push(_ token: String, label: String? = "fix the tests", project: String? = "yaran", tab: String? = nil) -> AgentPush {
        AgentPush(machineId: machine, agentId: "agent-1", tabId: tab, token: token, project: project, label: label)
    }

    func content(_ payload: PushPayload, mutes: LocalMutes = .init(), timeSensitive: Bool = false) -> PushNotificationContent? {
        builder.content(for: payload, orgId: "org-1", directory: directory, mutes: mutes, timeSensitive: timeSensitive, now: now)
    }

    @Test func raisedWithNames() throws {
        let c = try #require(content(.attentionRaised(push("needs_attention"), ts: 1)))
        #expect(c.title == "fix the tests needs you")
        #expect(c.body == "yaran · build-box")
        #expect(c.threadIdentifier == "org-1/\(machine)")
        #expect(c.categoryIdentifier == NotificationContentBuilder.agentCategory)
        #expect(c.userInfo == ["org": "org-1", "machine": machine, "agent": "agent-1", "kind": "attention_raised"])
        #expect(c.interruption == .active)
        #expect(c.playsSound)
    }

    @Test func minimalDetailAndExtraTab() throws {
        let c = try #require(content(.attentionRaised(push("needs_attention", label: nil, project: nil, tab: "t2"), ts: 1)))
        #expect(c.title == "An agent needs you")
        #expect(c.body == "build-box")
        #expect(c.userInfo["tab"] == "t2")
    }

    @Test func unknownMachineAndTimeSensitive() throws {
        let other = AgentPush(machineId: "11111111-1111-4111-8111-111111111111", agentId: "a", tabId: nil, token: "needs_attention", project: nil, label: nil)
        let c = try #require(content(.attentionRaised(other, ts: 1), timeSensitive: true))
        #expect(c.body == "A machine not on this phone")
        #expect(c.interruption == .timeSensitive)
    }

    @Test func everyEndingToken() throws {
        let expected = [
            "launch_failed": "fix the tests failed to start",
            "exited": "fix the tests stopped with an error",
            "exited_unknown": "fix the tests stopped unexpectedly",
            "rapid_clean_exit": "fix the tests exited right after starting",
        ]
        for (token, title) in expected {
            #expect(content(.agentExitedBadly(push(token), ts: 1))?.title == title)
            #expect(content(.agentExitedBadly(push(token, label: nil), ts: 1))?.title.hasPrefix("An agent") == true)
        }
    }

    @Test func unknownTokensKeepTheGenericText() {
        #expect(content(.attentionRaised(push("brand_new_state"), ts: 1)) == nil)
        #expect(content(.agentExitedBadly(push("needs_attention"), ts: 1)) == nil)
        #expect(content(.attentionCleared(push("brand_new_state"), ts: 1)) == nil)
    }

    @Test func mutedIsPassiveAndSilent() throws {
        for mutes in [LocalMutes(muteAll: true), LocalMutes(mutedUntil: now.addingTimeInterval(60)), LocalMutes(mutedMachineIds: [machine])] {
            let c = try #require(content(.attentionRaised(push("needs_attention"), ts: 1), mutes: mutes, timeSensitive: true))
            #expect(c.interruption == .passive)
            #expect(!c.playsSound)
        }
        let expired = LocalMutes(mutedUntil: now.addingTimeInterval(-1))
        #expect(content(.attentionRaised(push("needs_attention"), ts: 1), mutes: expired)?.interruption == .active)
    }

    @Test func clearedIsAPassiveReplacement() throws {
        let c = try #require(content(.attentionCleared(push("typing"), ts: 1)))
        #expect(c.title == "fix the tests no longer needs you")
        #expect(c.interruption == .passive)
        #expect(c.relevanceScore == 0)
        #expect(!c.playsSound)
    }

    @Test func testPush() throws {
        let c = try #require(content(.test(ts: 1)))
        #expect(c.title == "Test notification from Acme")
        let noDirectory = builder.content(for: .test(ts: 1), orgId: "o", directory: nil, mutes: .init(), timeSensitive: false, now: now)
        #expect(noDirectory?.title == "Test notification from your organization")
    }

    @Test func payloadTextIsSanitized() throws {
        let c = try #require(content(.attentionRaised(push("needs_attention", label: "a\u{202E}b", project: "p\u{1B}"), ts: 1)))
        #expect(c.title == "ab needs you")
        #expect(c.body == "p · build-box")
    }

    @Test func applyWritesSystemContent() throws {
        let c = try #require(content(.attentionRaised(push("needs_attention"), ts: 1), timeSensitive: true))
        let system = UNMutableNotificationContent()
        c.apply(to: system)
        #expect(system.title == c.title)
        #expect(system.threadIdentifier == c.threadIdentifier)
        #expect(system.interruptionLevel == .timeSensitive)
        #expect(system.userInfo["agent"] as? String == "agent-1")
    }

    @Test func everyPhraseHasAnEnglishBaseline() {
        for phrase in PushPhrase.allCases { #expect(!phrase.english.isEmpty) }
    }
}
