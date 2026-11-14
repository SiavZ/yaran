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
    private let re: NSRegularExpression

    public init(_ pattern: String) {
        // The patterns are compile-time constants; a bad one is a programming error.
        re = try! NSRegularExpression(pattern: "^(?:" + pattern + ")$")
    }

    public func matches(_ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// The capture groups of a whole-string match (nil for a group that did not take part).
    public func groups(_ s: String) -> [String?]? {
        guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        return (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } }
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
public func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for (x, y) in zip(a, b) { diff |= x ^ y }
    return diff == 0
}
