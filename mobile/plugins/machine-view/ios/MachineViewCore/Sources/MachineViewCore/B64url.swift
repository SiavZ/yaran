/// Unpadded base64url (RFC 4648 §5), strict: the only text form any wire value uses.
///
/// Decoding refuses padding, whitespace, characters outside the url-safe alphabet and
/// non-canonical trailing bits, so a value decodes to exactly one byte string.
///
/// - Pure; no allocation beyond the result.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/B64url
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public enum B64url {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func encode(_ bytes: [UInt8]) -> String { encode(Data(bytes)) }

    /// Nil unless `text` is canonical unpadded base64url.
    public static func decode(_ text: String) -> Data? {
        guard text.utf8.allSatisfy({ isAlphabet($0) }), text.utf8.count % 4 != 1 else { return nil }
        var std = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        std += String(repeating: "=", count: (4 - std.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: std), encode(data) == text else { return nil }
        return data
    }

    private static func isAlphabet(_ c: UInt8) -> Bool {
        (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c == 0x2D || c == 0x5F
    }
}
