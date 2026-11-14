/// HostRules: the one place that decides whether a typed or scanned address is acceptable.
///
/// `orgUrl` turns an org address into the canonical 02 `OrgUrl` (`https://<lowercase host>`)
/// or refuses it with a stable code; `host` does the same for a bare machine hostname. The
/// check order is shared with the Kotlin core and the shell, pinned by
/// `mobile/plugins/core/fixtures/host-rules-cases.json`.
///
/// - https only; no userinfo, IP literal, port other than 443, path, query or fragment.
/// - shortcut: every IDN (non-ASCII or any `xn--` label) is refused outright rather than doing
///   mixed-script detection; upgrade if a real org needs an IDN domain.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranCore/HostRules
/// └── YaranCoreTests/FixtureTests (inferred)
/// <module-headers:end>

import Foundation

/// Stable refusal codes (the raw values cross the bridge and the fixture).
public enum HostRefusal: String, Sendable, CaseIterable {
    case empty, notHttps = "not_https", userinfo, ipLiteral = "ip_literal", idn, port, path, query
    case fragment, invalid
}

public enum HostRulesResult: Equatable, Sendable {
    case ok(String)
    case refused(HostRefusal)
}

public enum HostRules {
    private static let scheme = "https://"

    /// Canonicalises an org URL or refuses it. Pure.
    public static func orgUrl(_ input: String) -> HostRulesResult {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .refused(.empty) }
        guard text.lowercased().hasPrefix(scheme) else { return .refused(.notHttps) }
        let rest = text.dropFirst(scheme.count)
        let authorityEnd = rest.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rest.endIndex
        let authority = String(rest[..<authorityEnd])
        let remainder = rest[authorityEnd...]
        if authority.contains("@") { return .refused(.userinfo) }
        if authority.hasPrefix("[") { return .refused(.ipLiteral) }
        var host = authority
        if let colon = authority.lastIndex(of: ":") {
            if authority[authority.index(after: colon)...] != "443" { return .refused(.port) }
            host = String(authority[..<colon])
        }
        if host.isEmpty { return .refused(.invalid) }
        if let refusal = checkHost(host) { return .refused(refusal) }
        let pathEnd = remainder.firstIndex { $0 == "?" || $0 == "#" } ?? remainder.endIndex
        let path = remainder[..<pathEnd]
        if !path.isEmpty && path != "/" { return .refused(.path) }
        if pathEnd < remainder.endIndex {
            return .refused(remainder[pathEnd] == "?" ? .query : .fragment)
        }
        return .ok(scheme + host.lowercased())
    }

    /// Canonicalises a bare machine hostname or refuses it. Pure.
    public static func host(_ input: String) -> HostRulesResult {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return .refused(.empty) }
        if text.hasPrefix("[") { return .refused(.ipLiteral) }
        if text.contains("@") { return .refused(.userinfo) }
        if text.contains("/") || text.contains(":") { return .refused(.invalid) }
        if let refusal = checkHost(text) { return .refused(refusal) }
        return .ok(text.lowercased())
    }

    /// IDN, IP-literal and label checks shared by both entry points.
    private static func checkHost(_ raw: String) -> HostRefusal? {
        let host = raw.lowercased()
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        if !host.allSatisfy(\.isASCII) || labels.contains(where: { $0.hasPrefix("xn--") }) {
            return .idn
        }
        if labels.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) { return .ipLiteral }
        guard labels.count >= 2, host.count <= 253,
              labels.allSatisfy(isValidLabel),
              let last = labels.last, (2...63).contains(last.count),
              last.allSatisfy({ ("a"..."z").contains($0) })
        else { return .invalid }
        return nil
    }

    /// `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`
    private static func isValidLabel(_ label: Substring) -> Bool {
        let allowed: (Character) -> Bool = { ("a"..."z").contains($0) || ("0"..."9").contains($0) }
        guard (1...63).contains(label.count),
              let first = label.first, let last = label.last,
              allowed(first), allowed(last)
        else { return false }
        return label.allSatisfy { allowed($0) || $0 == "-" }
    }
}
