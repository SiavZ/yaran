/// The `YaranApp/<version> (<os>; <form>)` token (Phase 02 §11) the app appends to its UA.
///
/// The machine WebView appends it to the system user agent (`applicationNameForUserAgent`),
/// and the org API client sends it as the whole `User-Agent`. Pinned by
/// `cloud/protocol/fixtures/ua/ua.json`.
///
/// - Pure. A version outside the protocol grammar is refused rather than sent.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/UaToken
/// └── MachineViewCore/Patterns (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/UaToken
/// ├── MachineView/AppServices (inferred)
/// └── MachineViewCoreTests/FormatTests (inferred)
/// <module-headers:end>
import Foundation

public enum UaToken {
    public enum Os: String { case android, ios }
    public enum Form: String { case phone, tablet }

    private static let versionRe = Pattern("[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?")

    /// Nil when `version` is not a protocol version string.
    public static func token(version: String, os: Os, form: Form) -> String? {
        versionRe.matches(version) ? "YaranApp/\(version) (\(os.rawValue); \(form.rawValue))" : nil
    }
}
