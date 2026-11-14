/// The house URL splitter: scheme, authority, path, query and fragment, never the platform parser.
///
/// `URL`/`URLComponents` and `java.net.URI` disagree on edge cases (userinfo, backslashes, IDN,
/// empty ports), so both twins split URLs with the same few rules and decide on the parts.
///
/// - Refuses any character at or below U+0020, U+007F, or outside ASCII.
/// - Scheme is lowercased; nothing else is normalized or decoded.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/UrlParts
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/UrlParts
/// └── MachineViewCore/NavigationPolicy (inferred)
/// <module-headers:end>
import Foundation

public struct UrlParts: Equatable {
    public let scheme: String
    /// Everything after `scheme:`.
    public let rest: String
    /// Present when `rest` starts with `//`: the text up to the first `/`, `?` or `#`.
    public let authority: String?
    public let path: String
    public let query: String?
    public let fragment: String?

    private static let schemeRe = Pattern("([A-Za-z][A-Za-z0-9+.-]*):(.*)")

    public static func parse(_ s: String) -> UrlParts? {
        guard s.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value < 0x7F }),
              let g = schemeRe.groups(s), let scheme = g[0], let rest = g[1] else { return nil }
        var tail = Substring(rest)
        var authority: String?
        if tail.hasPrefix("//") {
            tail = tail.dropFirst(2)
            let end = tail.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? tail.endIndex
            authority = String(tail[..<end])
            tail = tail[end...]
        }
        var fragment: String?
        if let hash = tail.firstIndex(of: "#") {
            fragment = String(tail[tail.index(after: hash)...])
            tail = tail[..<hash]
        }
        var query: String?
        if let q = tail.firstIndex(of: "?") {
            query = String(tail[tail.index(after: q)...])
            tail = tail[..<q]
        }
        return UrlParts(scheme: scheme.lowercased(), rest: rest, authority: authority, path: String(tail),
                        query: query, fragment: fragment)
    }

    /// Host (lowercased, a valid Hostname) and optional port of a server authority; nil for
    /// userinfo, IP-literal brackets, a malformed port or an invalid host.
    public var hostAndPort: (host: String, port: Int?)? {
        guard let authority, !authority.contains("@"), !authority.hasPrefix("[") else { return nil }
        var host = Substring(authority)
        var port: Int?
        if let colon = authority.lastIndex(of: ":") {
            let digits = authority[authority.index(after: colon)...]
            guard (1...5).contains(digits.count), digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
            port = Int(digits)
            host = authority[..<colon]
        }
        let lower = host.lowercased()
        return Pattern.hostname.matches(lower) ? (lower, port) : nil
    }
}
