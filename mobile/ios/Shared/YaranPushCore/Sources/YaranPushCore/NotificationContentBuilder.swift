/// Words and shapes the notification for one decrypted push: title, body, grouping, category,
/// `userInfo` and interruption level.
///
/// `s` is a token, never display text: the builder maps the known RowState and ending tokens
/// to localized phrases and falls back to the generic text for any token it does not know.
/// Mutes (the local mirror) turn a raise into a silent `.passive` delivery; a cleared event
/// that reached the NSE as an alert becomes a `.passive` "no longer needs you" replacement.
///
/// - Every payload string and cached name passes `PushText.display` first.
/// - Pure apart from the injected localizer, so the Swift tests pin every wording.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCore/NotificationContentBuilder
/// ├── YaranPushCore/PushPayload (inferred)
/// └── YaranPushCore/SharedPushState (inferred)
/// External: Foundation, UserNotifications
///
/// Used by:
/// YaranPushCore/NotificationContentBuilder
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCoreTests/NotificationContentTests (inferred)
/// ├── YaranPushCoreTests/PushInboxTests (inferred)
/// ├── YaranPushRegistration/PresentationPolicy (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation
import UserNotifications

public enum PushInterruption: Equatable, Sendable {
    case passive, active, timeSensitive
}

/// What the NSE (or a local post) shows; `apply(to:)` writes it onto the system content.
public struct PushNotificationContent: Equatable, Sendable {
    public var title: String
    public var body: String
    public var threadIdentifier: String
    public var categoryIdentifier: String
    public var userInfo: [String: String]
    public var interruption: PushInterruption
    public var relevanceScore: Double
    public var playsSound: Bool

    public func apply(to content: UNMutableNotificationContent) {
        content.title = title
        content.body = body
        content.threadIdentifier = threadIdentifier
        content.categoryIdentifier = categoryIdentifier
        content.userInfo = userInfo
        content.relevanceScore = relevanceScore
        content.sound = playsSound ? .default : nil
        content.interruptionLevel = switch interruption {
        case .passive: .passive
        case .active: .active
        case .timeSensitive: .timeSensitive
        }
    }
}

/// The phrase keys the app's `Localizable.strings` may override; values are the English baseline.
public enum PushPhrase: String, CaseIterable, Sendable {
    case genericTitle = "PUSH_GENERIC_TITLE"
    case genericBody = "PUSH_GENERIC_BODY"
    case needsYou = "PUSH_NEEDS_YOU"
    case needsYouAnonymous = "PUSH_NEEDS_YOU_ANON"
    case noLongerNeedsYou = "PUSH_CLEARED"
    case noLongerNeedsYouAnonymous = "PUSH_CLEARED_ANON"
    case launchFailed = "PUSH_EXIT_LAUNCH_FAILED"
    case launchFailedAnonymous = "PUSH_EXIT_LAUNCH_FAILED_ANON"
    case exitedWithError = "PUSH_EXIT_ERROR"
    case exitedWithErrorAnonymous = "PUSH_EXIT_ERROR_ANON"
    case exitedUnknown = "PUSH_EXIT_UNKNOWN"
    case exitedUnknownAnonymous = "PUSH_EXIT_UNKNOWN_ANON"
    case rapidExit = "PUSH_EXIT_RAPID"
    case rapidExitAnonymous = "PUSH_EXIT_RAPID_ANON"
    case testTitle = "PUSH_TEST_TITLE"
    case testBody = "PUSH_TEST_BODY"
    case bodyProjectMachine = "PUSH_BODY_PROJECT_MACHINE"
    case unknownMachine = "PUSH_UNKNOWN_MACHINE"
    case unknownOrg = "PUSH_UNKNOWN_ORG"

    public var english: String {
        switch self {
        case .genericTitle: "An agent needs attention"
        case .genericBody: "Open yaran to see which agent."
        case .needsYou: "%@ needs you"
        case .needsYouAnonymous: "An agent needs you"
        case .noLongerNeedsYou: "%@ no longer needs you"
        case .noLongerNeedsYouAnonymous: "An agent no longer needs you"
        case .launchFailed: "%@ failed to start"
        case .launchFailedAnonymous: "An agent failed to start"
        case .exitedWithError: "%@ stopped with an error"
        case .exitedWithErrorAnonymous: "An agent stopped with an error"
        case .exitedUnknown: "%@ stopped unexpectedly"
        case .exitedUnknownAnonymous: "An agent stopped unexpectedly"
        case .rapidExit: "%@ exited right after starting"
        case .rapidExitAnonymous: "An agent exited right after starting"
        case .testTitle: "Test notification from %@"
        case .testBody: "Notifications from this organization reach this phone."
        case .bodyProjectMachine: "%1$@ · %2$@"
        case .unknownMachine: "A machine not on this phone"
        case .unknownOrg: "your organization"
        }
    }
}

public struct NotificationContentBuilder: Sendable {
    public static let agentCategory = "YARAN_AGENT"
    public static let muteMachineAction = "YARAN_MUTE_MACHINE"

    public typealias Localizer = @Sendable (PushPhrase) -> String
    let localize: Localizer

    public init(localize: @escaping Localizer = { NSLocalizedString($0.rawValue, value: $0.english, comment: "") }) {
        self.localize = localize
    }

    /// The content for a decrypted payload, or nil when only the generic text fits.
    public func content(
        for payload: PushPayload, orgId: String, directory: OrgDirectory?, mutes: LocalMutes,
        timeSensitive: Bool, now: Date
    ) -> PushNotificationContent? {
        guard let push = payload.agent else {
            let org = directory.map { PushText.display($0.orgName) }.flatMap { $0.isEmpty ? nil : $0 }
            return PushNotificationContent(
                title: format(.testTitle, org ?? localize(.unknownOrg)), body: localize(.testBody),
                threadIdentifier: "\(orgId)/test", categoryIdentifier: "", userInfo: ["org": orgId, "kind": PushKind.test.rawValue],
                interruption: .active, relevanceScore: 0.5, playsSound: true
            )
        }
        guard let title = title(for: payload, push: push) else { return nil }
        let muted = mutes.isMuted(machineId: push.machineId, now: now)
        var userInfo = ["org": orgId, "machine": push.machineId, "agent": push.agentId, "kind": kindName(payload)]
        if let tab = push.tabId { userInfo["tab"] = tab }
        let interruption: PushInterruption
        switch payload {
        case .attentionRaised: interruption = muted ? .passive : (timeSensitive ? .timeSensitive : .active)
        case .agentExitedBadly: interruption = muted ? .passive : .active
        case .attentionCleared, .test: interruption = .passive
        }
        let silent: Bool = switch payload {
        case .attentionCleared: true
        case .attentionRaised, .agentExitedBadly, .test: muted
        }
        return PushNotificationContent(
            title: title, body: body(push: push, directory: directory),
            threadIdentifier: "\(orgId)/\(push.machineId)", categoryIdentifier: Self.agentCategory,
            userInfo: userInfo, interruption: interruption, relevanceScore: silent ? 0 : 1, playsSound: !silent
        )
    }

    private func title(for payload: PushPayload, push: AgentPush) -> String? {
        let label = push.label.map(PushText.display).flatMap { $0.isEmpty ? nil : $0 }
        let phrases: (PushPhrase, PushPhrase)?
        switch payload {
        case .attentionRaised:
            phrases = push.token == "needs_attention" ? (.needsYou, .needsYouAnonymous) : nil
        case .attentionCleared:
            phrases = Self.rowStateTokens.contains(push.token) ? (.noLongerNeedsYou, .noLongerNeedsYouAnonymous) : nil
        case .agentExitedBadly:
            phrases = switch push.token {
            case "launch_failed": (.launchFailed, .launchFailedAnonymous)
            case "exited": (.exitedWithError, .exitedWithErrorAnonymous)
            case "exited_unknown": (.exitedUnknown, .exitedUnknownAnonymous)
            case "rapid_clean_exit": (.rapidExit, .rapidExitAnonymous)
            default: nil
            }
        case .test:
            phrases = nil
        }
        guard let phrases else { return nil }
        let (named, anonymous) = phrases
        return label.map { format(named, $0) } ?? localize(anonymous)
    }

    private func body(push: AgentPush, directory: OrgDirectory?) -> String {
        let machine = directory?.machines[push.machineId].map(PushText.display).flatMap { $0.isEmpty ? nil : $0 }
            ?? localize(.unknownMachine)
        guard let project = push.project.map(PushText.display), !project.isEmpty else { return machine }
        return format(.bodyProjectMachine, project, machine)
    }

    private func kindName(_ payload: PushPayload) -> String {
        switch payload {
        case .attentionRaised: PushKind.attentionRaised.rawValue
        case .attentionCleared: PushKind.attentionCleared.rawValue
        case .agentExitedBadly: PushKind.agentExitedBadly.rawValue
        case .test: PushKind.test.rawValue
        }
    }

    private func format(_ phrase: PushPhrase, _ args: CVarArg...) -> String {
        String(format: localize(phrase), arguments: args)
    }

    static let rowStateTokens: Set<String> = ["needs_attention", "typing", "busy", "idle", "detached", "exited"]
}
