/// The non-secret push state the app writes and the NSE reads, in App Group `UserDefaults`.
///
/// Holds each org's local mute mirror (02's `mute_all` / `muted_until` / `muted_machine_ids`),
/// the cached org and machine names the notification text uses, and whether the
/// time-sensitive entitlement is in effect.
///
/// - Nothing secret lives here: keys and endpoints are in `PushSubscriptionStore`.
/// - The mirror only covers the gap before a sync; the Worker's device record is the source
///   of truth and already stops muted sends.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranPushCore/SharedPushState
/// ├── NotificationService/NotificationService (inferred)
/// ├── PushPlugin/NotificationRouter+Push (inferred)
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCoreTests/NotificationContentTests (inferred)
/// ├── YaranPushCoreTests/PushInboxTests (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation

/// 02's per-device mute fields, mirrored locally.
public struct LocalMutes: Codable, Equatable, Sendable {
    public var muteAll: Bool
    public var mutedUntil: Date?
    public var mutedMachineIds: [String]

    public init(muteAll: Bool = false, mutedUntil: Date? = nil, mutedMachineIds: [String] = []) {
        self.muteAll = muteAll
        self.mutedUntil = mutedUntil
        self.mutedMachineIds = mutedMachineIds
    }

    /// 02: a push is sent only when !mute_all && (muted_until == nil || now >= muted_until)
    /// && machine not in muted_machine_ids.
    public func isMuted(machineId: String, now: Date) -> Bool {
        if muteAll { return true }
        if let until = mutedUntil, now < until { return true }
        return mutedMachineIds.contains(machineId)
    }
}

/// The names one org's notifications are worded with.
public struct OrgDirectory: Codable, Equatable, Sendable {
    public var orgName: String
    public var machines: [String: String]

    public init(orgName: String, machines: [String: String]) {
        self.orgName = orgName
        self.machines = machines
    }
}

public final class SharedPushState: @unchecked Sendable {
    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// The App Group suite; nil when the group is not provisioned.
    public convenience init?(appGroup: String) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }
        self.init(defaults: defaults)
    }

    public func mutes(orgId: String) -> LocalMutes {
        read(LocalMutes.self, key: "push.mutes.\(orgId)") ?? LocalMutes()
    }

    public func setMutes(_ mutes: LocalMutes, orgId: String) {
        write(mutes, key: "push.mutes.\(orgId)")
    }

    public func directory(orgId: String) -> OrgDirectory? {
        read(OrgDirectory.self, key: "push.directory.\(orgId)")
    }

    public func setDirectory(_ directory: OrgDirectory, orgId: String) {
        write(directory, key: "push.directory.\(orgId)")
    }

    public var timeSensitiveEnabled: Bool {
        get { defaults.bool(forKey: "push.timeSensitive") }
        set { defaults.set(newValue, forKey: "push.timeSensitive") }
    }

    /// Set only once Apple grants `com.apple.developer.usernotifications.filtering` (UNVERIFIED).
    public var filteringEnabled: Bool {
        get { defaults.bool(forKey: "push.filtering") }
        set { defaults.set(newValue, forKey: "push.filtering") }
    }

    /// Removes everything stored for one org (org removal, push off, device revoked).
    public func forget(orgId: String) {
        defaults.removeObject(forKey: "push.mutes.\(orgId)")
        defaults.removeObject(forKey: "push.directory.\(orgId)")
    }

    private func read<T: Decodable>(_ type: T.Type, key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    private func write<T: Encodable>(_ value: T, key: String) {
        defaults.set(try? JSONEncoder().encode(value), forKey: key)
    }
}
