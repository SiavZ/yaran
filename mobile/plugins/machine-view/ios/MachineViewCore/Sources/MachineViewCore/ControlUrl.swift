/// `yaranapp://` URIs (Phase 02 §10): the split, parameter decoding and in-WebView decision.
///
/// A port of `@yaran/protocol` `parseUri`, `parseAppUri` and `controlUrlDecision`, pinned by
/// `cloud/protocol/fixtures/uri/control-urls.json`. The machine window turns `reauth` (for its
/// own host only), `home` and `settings` into native actions; every other `yaranapp://` URI is
/// ignored with a diagnostics entry, so no other app can ever receive one.
///
/// - Pure. Duplicate keys and bad percent-escapes make the whole URI invalid.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/ControlUrl
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/ControlUrl
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/NavigationPolicy (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

public struct SplitUri: Equatable {
    public let scheme: String
    public let authority: String
    public let path: String
    public let query: String?
    public let fragment: String?

    /// Authority plus path, e.g. "add-org", "auth/callback", "reauth".
    public var command: String { authority + path }

    private static let re = Pattern("([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)(/[^?#]*)?(?:\\?([^#]*))?(?:#(.*))?")

    /// Splits without decoding; nil when the shape is wrong.
    public static func split(_ uri: String) -> SplitUri? {
        guard let g = re.groups(uri), let scheme = g[0], let authority = g[1] else { return nil }
        return SplitUri(scheme: scheme.lowercased(), authority: authority, path: g[2] ?? "", query: g[3], fragment: g[4])
    }

    /// `decodeURIComponent` over `k=v&k=v`; nil on a duplicate key or a bad escape.
    public static func params(_ text: String?) -> [String: String]? {
        var out: [String: String] = [:]
        guard let text, !text.isEmpty else { return out }
        for pair in text.split(separator: "&", omittingEmptySubsequences: false) where !pair.isEmpty {
            let eq = pair.firstIndex(of: "=")
            let rawKey = eq.map { pair[..<$0] } ?? pair
            let rawValue = eq.map { pair[pair.index(after: $0)...] } ?? ""
            guard let key = String(rawKey).removingPercentEncoding,
                  let value = String(rawValue).removingPercentEncoding,
                  out[key] == nil else { return nil }
            out[key] = value
        }
        return out
    }
}

public enum AppUri: Equatable {
    case addOrg(orgUrl: String)
    case reauth(host: String)
    case home
    case settings
    case invalid
}

public enum ControlDecision: Equatable {
    case reauth
    case home
    case settings
    /// `code` is `uri_invalid` for a malformed URI, nil for a valid one that is not for us.
    case ignore(code: String?)
}

public enum ControlUrl {
    public static let maxChars = 512

    public static func parse(_ uri: String) -> AppUri {
        guard uri.utf16.count <= maxChars, let s = SplitUri.split(uri), s.scheme == "yaranapp",
              let query = SplitUri.params(s.query), SplitUri.params(s.fragment) != nil else { return .invalid }
        switch s.command {
        case "add-org":
            guard let u = query["u"], Pattern.orgUrl.matches(u) else { return .invalid }
            return .addOrg(orgUrl: u)
        case "reauth":
            guard let host = query["host"], Pattern.hostname.matches(host) else { return .invalid }
            return .reauth(host: host)
        case "home":
            return .home
        case "settings":
            return .settings
        default:
            return .invalid
        }
    }

    public static func decision(_ uri: String, loadedHost: String) -> ControlDecision {
        switch parse(uri) {
        case .invalid: return .ignore(code: "uri_invalid")
        case .reauth(let host): return host == loadedHost ? .reauth : .ignore(code: nil)
        case .home: return .home
        case .settings: return .settings
        case .addOrg: return .ignore(code: nil)
        }
    }
}
