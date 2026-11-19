/// The wire-format patterns this plugin checks, written once (Phase 02 schemas and uri.ts).
///
/// Every pattern is matched against the whole string; the regexes come from the protocol
/// schemas (`Hostname`, `OrgUrl`, `HandoffState`, …) so the native checks agree with the
/// validators the Worker and yaran run.
///
/// - Pure; the compiled expressions are immutable statics.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/Patterns
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MachineViewPlugin (inferred)
/// ├── MachineView/SessionPlugin (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/ControlUrl (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/RouteFragment (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/UaToken (inferred)
/// ├── MachineViewCore/UrlParts (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public struct Pattern {
    private let regex: NSRegularExpression

    public init(_ pattern: String) {
        // The patterns are compile-time constants, each exercised by tests; a bad one is a programming error.
        // swiftlint:disable:next force_try
        regex = try! NSRegularExpression(pattern: "^(?:" + pattern + ")$")
    }

    public func matches(_ text: String) -> Bool {
        regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// The capture groups of a whole-string match (nil for a group that did not take part).
    public func groups(_ text: String) -> [String?]? {
        guard let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
        return (1..<match.numberOfRanges).map { group in Range(match.range(at: group), in: text).map { String(text[$0]) } }
    }

    public static let hostname = Pattern(
        "(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*")
    public static let orgUrl = Pattern("https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}")
    public static let handoffState = Pattern("[A-Za-z0-9_-]{22,128}")
    public static let jwe = Pattern("[A-Za-z0-9_-]+\\.\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
    public static let errorCode = Pattern("[a-z][a-z0-9_]{0,63}")
    public static let protocolVersion = Pattern("[1-9][0-9]{0,4}")
    public static let unixSeconds = Pattern("0|[1-9][0-9]{0,11}")
    public static let jwt = Pattern("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")
    public static let installId = Pattern("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
    public static let p256Point = Pattern("B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]")
}

/// Constant-time byte comparison (length is not secret).
public func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    var diff: UInt8 = 0
    for (left, right) in zip(lhs, rhs) { diff |= left ^ right }
    return diff == 0
}
