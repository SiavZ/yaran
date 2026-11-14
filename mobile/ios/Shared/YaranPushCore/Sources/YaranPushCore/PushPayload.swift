/// The decrypted push payload v1 (02 §9) and the relay's top-level wrapping fields.
///
/// `PushPayload.parse` mirrors `@yaran/protocol`'s `parsePushPayload`: at most 320 bytes,
/// UTF-8 JSON, `v` 1, a known `k`, `test` carrying only `v`/`k`/`ts`, the id patterns, `s` as
/// a token and `p`/`l` at most 24 UTF-8 bytes. `RelayWrapping` reads `v`/`r`/`y` from an APNs
/// `userInfo`. `PushText.display` strips control and bidi characters before anything shows.
///
/// - Trust boundary: the payload is authenticated only as "holds the org's VAPID key and this
///   device's auth secret", so it is parsed strictly and displayed only after sanitizing.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCore/PushPayload
/// └── YaranPushCore/Base64URL (inferred)
/// External: Foundation
///
/// Used by:
/// YaranPushCore/PushPayload
/// ├── YaranPushCore/NotificationContentBuilder (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCoreTests/NotificationContentTests (inferred)
/// └── YaranPushCoreTests/PushPayloadTests (inferred)
/// <module-headers:end>
import Foundation

public enum PushKind: String, Sendable, CaseIterable {
    case attentionRaised = "attention_raised"
    case attentionCleared = "attention_cleared"
    case agentExitedBadly = "agent_exited_badly"
    case test
}

/// One agent-scoped push (every kind but `test`).
public struct AgentPush: Equatable, Sendable {
    public let machineId: String
    public let agentId: String
    public let tabId: String?
    /// RowState token for attention kinds, ending token for `agent_exited_badly`.
    public let token: String
    public let project: String?
    public let label: String?
}

public enum PushPayload: Equatable, Sendable {
    case attentionRaised(AgentPush, ts: Int)
    case attentionCleared(AgentPush, ts: Int)
    case agentExitedBadly(AgentPush, ts: Int)
    case test(ts: Int)

    public static let maxBytes = 320
    public static let maxTextBytes = 24

    public var agent: AgentPush? {
        switch self {
        case let .attentionRaised(push, _), let .attentionCleared(push, _), let .agentExitedBadly(push, _): push
        case .test: nil
        }
    }

    /// Strict device-side parse; nil is 02's `push_payload_invalid`.
    public static func parse(_ bytes: Data) -> PushPayload? {
        guard bytes.count <= maxBytes,
              String(data: bytes, encoding: .utf8) != nil,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              integer(object["v"]) == 1,
              let kindText = object["k"] as? String, let kind = PushKind(rawValue: kindText),
              let ts = integer(object["ts"]), ts >= 0
        else { return nil }
        switch kind {
        case .test:
            return Set(object.keys).isSubset(of: ["v", "k", "ts"]) ? .test(ts: ts) : nil
        case .attentionRaised:
            return agentPush(object).map { .attentionRaised($0, ts: ts) }
        case .attentionCleared:
            return agentPush(object).map { .attentionCleared($0, ts: ts) }
        case .agentExitedBadly:
            return agentPush(object).map { .agentExitedBadly($0, ts: ts) }
        }
    }

    private static func agentPush(_ object: [String: Any]) -> AgentPush? {
        guard let m = object["m"] as? String, matches(m, uuidPattern),
              let a = object["a"] as? String, matches(a, yaranIdPattern),
              let s = object["s"] as? String, matches(s, tokenPattern)
        else { return nil }
        var tab: String?
        if let t = object["t"] {
            guard let text = t as? String, matches(text, yaranIdPattern) else { return nil }
            tab = text
        }
        guard case let .some(p) = optionalText(object["p"]), case let .some(l) = optionalText(object["l"]) else { return nil }
        return AgentPush(machineId: m, agentId: a, tabId: tab, token: s, project: p, label: l)
    }

    /// `.some(nil)` when absent, `.none` when present but not a 1-24 byte string.
    private static func optionalText(_ value: Any?) -> String?? {
        guard let value else { return .some(nil) }
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= maxTextBytes else { return .none }
        return .some(text)
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, abs(double) < 9.007e15 else { return nil }
        return number.intValue
    }

    static let uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    static let yaranIdPattern = "^[\\x21-\\x7e]{1,128}$"
    static let tokenPattern = "^[a-z_]{1,32}$"

    /// Whole-string match (ICU's `$` would also accept a trailing newline).
    static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) == text.startIndex..<text.endIndex
    }
}

/// The relay's top-level fields in an APNs body (02 §9): `v` 1, `r` registration id, `y` body.
public struct RelayWrapping: Equatable, Sendable {
    public let registrationId: String
    public let body: Data

    public init?(userInfo: [AnyHashable: Any]) {
        guard (userInfo["v"] as? NSNumber)?.intValue == 1,
              let r = userInfo["r"] as? String, PushPayload.matches(r, PushPayload.uuidPattern),
              let y = userInfo["y"] as? String, !y.isEmpty, let body = Base64URL.decode(y)
        else { return nil }
        registrationId = r
        self.body = body
    }
}

public enum PushText {
    /// Removes C0/C1 controls and bidi overrides/isolates, then trims.
    public static func display(_ text: String) -> String {
        let kept = text.unicodeScalars.filter { scalar in
            !(scalar.properties.generalCategory == .control || bidiControls.contains(scalar.value))
        }
        return String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static let bidiControls: Set<UInt32> = [0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069]
}
