/// The NSE's and the background handler's one decision: what a relay push becomes on screen.
///
/// Reads the relay wrapping, selects the org subscription by `r`, decrypts `y`, parses the
/// payload and words it. Any failure keeps the relay's generic alert. A cleared event yields
/// the deliveries to remove (background push) or a `.passive` replacement (an alert from an old
/// relay), or nothing at all when the filtering entitlement is in effect.
///
/// - Loads no Capacitor and no third-party code: CryptoKit, the keychain and App Group defaults.
/// - `DeliveredFilter` matches delivered notifications by their `userInfo`, so the device never
///   has to recompute the topic to clear one.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCore/PushInbox
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushPayload (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// └── YaranPushCore/WebPushDecryptor (inferred)
/// External: Foundation
///
/// Used by:
/// YaranPushCore/PushInbox
/// ├── NotificationService/NotificationService (inferred)
/// ├── PushPlugin/NotificationRouter+Push (inferred)
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushCoreTests/PushInboxTests (inferred)
/// └── YaranPushRegistration/PresentationPolicy (inferred)
/// <module-headers:end>
import Foundation

public enum InboxOutcome: Equatable, Sendable {
    /// Leave the relay's generic localized alert in place.
    case keepGeneric(InboxFailure)
    /// Replace the alert with this content.
    case show(PushNotificationContent)
    /// Deliver nothing (cleared event with the filtering entitlement).
    case suppress
}

public enum InboxFailure: Error, Equatable, Sendable {
    case notRelayPush, unknownRegistration, keychainUnavailable, decryptFailed, payloadInvalid, unwordable
}

/// Which delivered notifications one clear or one agent-open removes.
public struct DeliveredFilter: Equatable, Sendable {
    public enum TabMatch: Equatable, Sendable {
        case any
        /// nil is the slot tab (the payload omitted `t`).
        case exactly(String?)
    }

    public let orgId: String
    public let machineId: String
    public let agentId: String?
    public let tab: TabMatch

    public init(orgId: String, machineId: String, agentId: String?, tab: TabMatch) {
        self.orgId = orgId
        self.machineId = machineId
        self.agentId = agentId
        self.tab = tab
    }

    public func matches(_ userInfo: [AnyHashable: Any]) -> Bool {
        guard userInfo["org"] as? String == orgId, userInfo["machine"] as? String == machineId else { return false }
        if let agentId, userInfo["agent"] as? String != agentId { return false }
        switch tab {
        case .any: return true
        case let .exactly(tabId): return userInfo["tab"] as? String == tabId
        }
    }
}

public struct PushInbox: Sendable {
    let subscriptions: PushSubscriptionStore
    let state: SharedPushState
    let builder: NotificationContentBuilder

    public init(subscriptions: PushSubscriptionStore, state: SharedPushState, builder: NotificationContentBuilder = .init()) {
        self.subscriptions = subscriptions
        self.state = state
        self.builder = builder
    }

    /// Decrypts and parses a relay push; the org id comes from the local store, never the payload.
    public func open(userInfo: [AnyHashable: Any]) -> Result<(orgId: String, payload: PushPayload), InboxFailure> {
        guard let wrapping = RelayWrapping(userInfo: userInfo) else { return .failure(.notRelayPush) }
        let found: PushSubscription?
        do {
            found = try subscriptions.find(registrationId: wrapping.registrationId)
        } catch {
            return .failure(.keychainUnavailable)
        }
        guard let subscription = found else { return .failure(.unknownRegistration) }
        guard let key = try? subscription.agreementKey(),
              let plain = try? WebPushDecryptor.decrypt(body: wrapping.body, uaPrivate: key, authSecret: subscription.authSecret)
        else { return .failure(.decryptFailed) }
        guard let payload = PushPayload.parse(plain) else { return .failure(.payloadInvalid) }
        return .success((subscription.orgId, payload))
    }

    /// The NSE's answer for an alert push.
    public func alertOutcome(userInfo: [AnyHashable: Any], now: Date) -> InboxOutcome {
        let opened: (orgId: String, payload: PushPayload)
        switch open(userInfo: userInfo) {
        case let .failure(failure): return .keepGeneric(failure)
        case let .success(value): opened = value
        }
        if case .attentionCleared = opened.payload, state.filteringEnabled { return .suppress }
        guard let content = builder.content(
            for: opened.payload, orgId: opened.orgId, directory: state.directory(orgId: opened.orgId),
            mutes: state.mutes(orgId: opened.orgId), timeSensitive: state.timeSensitiveEnabled, now: now
        ) else { return .keepGeneric(.unwordable) }
        return .show(content)
    }

    /// The background handler's answer: which deliveries a cleared event removes (nil for any
    /// other kind or an unreadable push).
    public func clearFilter(userInfo: [AnyHashable: Any]) -> DeliveredFilter? {
        guard case let .success((orgId, payload)) = open(userInfo: userInfo),
              case let .attentionCleared(push, _) = payload
        else { return nil }
        return DeliveredFilter(orgId: orgId, machineId: push.machineId, agentId: push.agentId, tab: .exactly(push.tabId))
    }
}
