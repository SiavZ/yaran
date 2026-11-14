/// Agent routes `MachineView.open` accepts: `#/agent/<seg>` with an optional `/tab/<seg>`.
///
/// The restricted form of the web UI's `parseRoute` grammar (`store.ts`), pinned by
/// `fixtures/routes.json` with its Kotlin and TypeScript twins. A raw segment is one or more
/// of `[A-Za-z0-9-_.!~*'()]` or `%XX`; decoded it must be 1-128 printable ASCII bytes.
///
/// - Pure.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/RouteFragment
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RouteFragment
/// ├── MachineView/MachineViewPlugin (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

public enum RouteFragment {
    private static let seg = "((?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-Fa-f]{2})+)"
    private static let re = Pattern("#/agent/" + seg + "(?:/tab/" + seg + ")?")

    public static func isValid(_ route: String) -> Bool {
        guard let g = re.groups(route), let sid = g[0] else { return false }
        return segmentOk(sid) && (g[1].map(segmentOk) ?? true)
    }

    private static func segmentOk(_ raw: String) -> Bool {
        var bytes: [UInt8] = []
        var it = Array(raw.utf8)[...]
        while let c = it.popFirst() {
            if c == UInt8(ascii: "%") {
                guard it.count >= 2, let b = UInt8(String(decoding: it.prefix(2), as: UTF8.self), radix: 16) else { return false }
                bytes.append(b)
                it = it.dropFirst(2)
            } else {
                bytes.append(c)
            }
        }
        return (1...128).contains(bytes.count) && bytes.allSatisfy { $0 >= 0x20 && $0 <= 0x7E }
    }
}
