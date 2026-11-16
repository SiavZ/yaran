/// Foreground presentation, the notification category and the tap payload for the iOS plugin.
///
/// `willPresent` shows nothing when the shell reports that exact agent and tab on screen, and
/// banner, list and sound otherwise. The one category carries the one action, "Mute this
/// machine", as a foreground action (the confirmation toast and the app lock need the app in
/// front). `TapEvent` is what `notificationTapped` hands JS: ids only, never a host.
///
/// - Pure; the plugin adapter feeds it system values.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushRegistration/PresentationPolicy
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// └── YaranPushCore/PushInbox (inferred)
/// External: Foundation, UserNotifications
///
/// Used by:
/// YaranPushRegistration/PresentationPolicy
/// ├── PushPlugin/NotificationRouter+Push (inferred)
/// ├── PushPlugin/PushPlugin (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation
import UserNotifications
import YaranPushCore

/// The agent tab the shell reports as visible in machine-view.
public struct VisibleAgent: Equatable, Sendable {
    public let orgId: String
    public let machineId: String
    public let agentId: String
    public let tabId: String?

    public init(orgId: String, machineId: String, agentId: String, tabId: String?) {
        self.orgId = orgId
        self.machineId = machineId
        self.agentId = agentId
        self.tabId = tabId
    }
}

/// `notificationTapped`'s payload.
public struct TapEvent: Equatable, Sendable {
    public enum Action: String, Sendable { case open, muteMachine = "mute_machine" }

    public let orgId: String
    public let machineId: String
    public let agentId: String?
    public let tabId: String?
    public let action: Action

    public init?(userInfo: [AnyHashable: Any], actionIdentifier: String) {
        guard let org = userInfo["org"] as? String else { return nil }
        let machine = userInfo["machine"] as? String
        action = actionIdentifier == NotificationContentBuilder.muteMachineAction ? .muteMachine : .open
        if action == .muteMachine && machine == nil { return nil }
        orgId = org
        machineId = machine ?? ""
        agentId = userInfo["agent"] as? String
        tabId = userInfo["tab"] as? String
    }

    public var dictionary: [String: Any] {
        var out: [String: Any] = ["orgId": orgId, "machineId": machineId, "action": action.rawValue]
        if let agentId { out["agentId"] = agentId }
        if let tabId { out["tabId"] = tabId }
        return out
    }
}

public enum PresentationPolicy {
    public static func foregroundOptions(userInfo: [AnyHashable: Any], visible: VisibleAgent?) -> UNNotificationPresentationOptions {
        if let visible,
           DeliveredFilter(orgId: visible.orgId, machineId: visible.machineId, agentId: visible.agentId, tab: .exactly(visible.tabId))
           .matches(userInfo) {
            return []
        }
        return [.banner, .list, .sound]
    }

    public static func categories(muteTitle: String) -> Set<UNNotificationCategory> {
        let mute = UNNotificationAction(identifier: NotificationContentBuilder.muteMachineAction, title: muteTitle, options: [.foreground])
        return [UNNotificationCategory(identifier: NotificationContentBuilder.agentCategory, actions: [mute], intentIdentifiers: [])]
    }
}
