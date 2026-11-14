/// Base64url (RFC 4648 §5, unpadded) for the push wire: keys, auth secrets and the relay's `y`.
///
/// - Decoding accepts unpadded input only from the url-safe alphabet and returns nil on
///   anything else, so a malformed relay field never reaches the decryptor.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranPushCore/Base64URL
/// ├── YaranPushCore/PushPayload (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/PushTopic (inferred)
/// ├── YaranPushCoreTests/Fixtures (inferred)
/// └── YaranPushCoreTests/PushInboxTests (inferred)
/// <module-headers:end>
import Foundation

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        guard text.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else {
            return nil
        }
        var b64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let rem = b64.count % 4
        if rem == 1 { return nil }
        if rem > 0 { b64 += String(repeating: "=", count: 4 - rem) }
        return Data(base64Encoded: b64)
    }
}
