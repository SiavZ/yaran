/// The phone's label for `HandoffQuery.device` and `DeviceRegistration.label`.
///
/// The OS device name, else the model, with control and bidi characters removed, trimmed and
/// cut to 64 code points; the consent page shows it, so a label can never reorder or hide the
/// text around it. Pinned by `fixtures/device-labels.json` with its Kotlin twin.
///
/// - Pure. Counts Unicode scalars (code points), never UTF-16 units or graphemes.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/DeviceLabel
/// ├── MachineView/AppServices (inferred)
/// └── MachineViewCoreTests/FormatTests (inferred)
/// <module-headers:end>
import Foundation

public enum DeviceLabel {
    public static let fallback = "Phone"
    public static let maxScalars = 64

    public static func clean(name: String?, model: String) -> String {
        let fromName = name.map(cleanOne) ?? ""
        if !fromName.isEmpty { return fromName }
        let fromModel = cleanOne(model)
        return fromModel.isEmpty ? fallback : fromModel
    }

    private static func cleanOne(_ s: String) -> String {
        let kept = s.unicodeScalars.filter { !isRemoved($0.value) }
        let cut = trimSpaces(Array(trimSpaces(Array(kept)).prefix(maxScalars)))
        var out = String.UnicodeScalarView()
        out.append(contentsOf: cut)
        return String(out)
    }

    private static func trimSpaces(_ a: [Unicode.Scalar]) -> [Unicode.Scalar] {
        Array(a.drop(while: { $0 == " " }).reversed().drop(while: { $0 == " " }).reversed())
    }

    private static func isRemoved(_ v: UInt32) -> Bool {
        v <= 0x1F || (0x7F...0x9F).contains(v) || v == 0x061C || v == 0x200E || v == 0x200F
            || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
    }
}
