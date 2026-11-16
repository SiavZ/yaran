/// 02's push collapse topic, `topic(m, a, t)`, computed on the device.
///
/// The first 32 characters of base64url(SHA-256("yaran-topic-v1\n" + m + "\n" + a + "\n" + t)),
/// with `t` empty for the slot tab. It equals the relay's `apns-collapse-id`, so the app can
/// name the delivered notification for one agent tab.
///
/// - Pure.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCore/PushTopic
/// └── YaranPushCore/Base64URL (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// YaranPushCore/PushTopic
/// └── YaranPushCoreTests/PushPayloadTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation

public enum PushTopic {
    public static func topic(machineId: String, agentId: String, tabId: String?) -> String {
        let input = "yaran-topic-v1\n\(machineId)\n\(agentId)\n\(tabId ?? "")"
        let digest = Data(SHA256.hash(data: Data(input.utf8)))
        return String(Base64URL.encode(digest).prefix(32))
    }
}
