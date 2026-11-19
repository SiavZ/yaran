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
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineView/MachineViewPlugin (inferred)
/// └── MachineViewCoreTests/PolicyTests (inferred)
/// <module-headers:end>
import Foundation

public enum RouteFragment {
    private static let seg = "((?:[A-Za-z0-9\\-_.!~*'()]|%[0-9A-Fa-f]{2})+)"
    private static let routePattern = Pattern("#/agent/" + seg + "(?:/tab/" + seg + ")?")

    public static func isValid(_ route: String) -> Bool {
        guard let groups = routePattern.groups(route), let sid = groups[0] else { return false }
        return segmentOk(sid) && (groups[1].map(segmentOk) ?? true)
    }

    private static func segmentOk(_ raw: String) -> Bool {
        var bytes: [UInt8] = []
        var rest = Array(raw.utf8)[...]
        while let byte = rest.popFirst() {
            if byte == UInt8(ascii: "%") {
                guard rest.count >= 2, let hex = String(bytes: rest.prefix(2), encoding: .utf8), let decoded = UInt8(hex, radix: 16) else { return false }
                bytes.append(decoded)
                rest = rest.dropFirst(2)
            } else {
                bytes.append(byte)
            }
        }
        return (1...128).contains(bytes.count) && bytes.allSatisfy { $0 >= 0x20 && $0 <= 0x7E }
    }
}
