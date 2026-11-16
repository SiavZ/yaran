/// Sanitizer: strips secrets and terminal control sequences from diagnostics text.
///
/// Every Diagnostics entry passes through `Sanitizer.sanitize` before it is kept in memory or
/// written to disk. The rules and their order are shared with the Kotlin core and pinned by
/// `mobile/plugins/core/fixtures/sanitizer-cases.json`.
///
/// - Rule 1: ANSI CSI, OSC and two-byte ESC sequences and C0 controls (except LF and TAB) go.
/// - Rule 2: `Authorization`, `Cookie` and `Set-Cookie` header values become `[redacted]`.
/// - Rule 3: JWT-shaped tokens become `[jwt]`.
/// - Rule 4: query strings and fragments are dropped from any `scheme://` token.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranCore/Sanitizer
/// ├── YaranCore/Diagnostics (inferred)
/// └── YaranCoreTests/FixtureTests (inferred)
/// <module-headers:end>

import Foundation

public enum Sanitizer {
    private static let header = regex(#"\b(Set-Cookie|Cookie|Authorization):[^\n]*"#, caseInsensitive: true)
    private static let jwt = regex(#"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"#)
    // The scheme starts a word and is bounded, so long words cannot make the scan quadratic.
    private static let urlTail = regex(#"(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}://[^\s?#]*)[?#]\S*"#)

    /// Applies the four rules in order. Pure.
    public static func sanitize(_ input: String) -> String {
        var text = stripControls(input)
        text = replace(header, in: text, with: "$1: [redacted]")
        text = replace(jwt, in: text, with: "[jwt]")
        return replace(urlTail, in: text, with: "$1")
    }

    private static func stripControls(_ input: String) -> String {
        let scalars = Array(input.unicodeScalars)
        var out = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            let value = scalars[index].value
            if value == 0x1B {
                index = skipEscape(scalars, from: index)
                continue
            }
            if value < 0x20 && value != 0x0A && value != 0x09 {
                index += 1
                continue
            }
            out.append(scalars[index])
            index += 1
        }
        return String(out)
    }

    /// Returns the index just past the escape sequence that starts at `start`.
    private static func skipEscape(_ scalars: [Unicode.Scalar], from start: Int) -> Int {
        var index = start + 1
        guard index < scalars.count else { return index }
        switch scalars[index] {
        case "[":
            index += 1
            while index < scalars.count, !(0x40...0x7E).contains(scalars[index].value) { index += 1 }
            return index + 1
        case "]":
            index += 1
            while index < scalars.count {
                if scalars[index].value == 0x07 { return index + 1 }
                if scalars[index].value == 0x1B, index + 1 < scalars.count, scalars[index + 1] == "\\" {
                    return index + 2
                }
                index += 1
            }
            return index
        default:
            return index + 1
        }
    }

    private static func regex(_ pattern: String, caseInsensitive: Bool = false) -> NSRegularExpression {
        // The patterns are literals; a failure here is a programming error caught by the tests.
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
    }

    private static func replace(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        return regex.stringByReplacingMatches(in: text, range: range, withTemplate: template)
    }
}
