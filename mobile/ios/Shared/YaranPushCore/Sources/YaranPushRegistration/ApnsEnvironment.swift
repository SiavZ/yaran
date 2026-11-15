/// The APNs environment of this build's device tokens, from its signed `aps-environment` entitlement.
///
/// iOS has no public API for an app's own entitlements, so the source is the provisioning profile
/// Xcode embeds and seals into the signature. Development and ad hoc builds carry one, and its
/// `aps-environment` (`development` or `production`) is the one the app was signed with. App Store
/// and TestFlight installs have the profile stripped and always use production. The simulator's
/// tokens are sandbox tokens.
///
/// - Pure; the plugin adapter reads `embedded.mobileprovision` and passes its bytes.
/// - Values are 02's `apns_environment`: `production` or `sandbox`.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// YaranPushRegistration/ApnsEnvironment
/// ├── PushPlugin/PushPlugin (inferred)
/// └── YaranPushRegistrationTests/ApnsEnvironmentTests (inferred)
/// <module-headers:end>
import Foundation

public enum ApnsEnvironment {
    /// `sandbox` for a development-signed or simulator build, `production` otherwise.
    public static func resolve(embeddedProfile: Data?, simulator: Bool) -> String {
        if simulator { return "sandbox" }
        guard let profile = embeddedProfile else { return "production" }
        return apsEnvironment(profile) == "development" ? "sandbox" : "production"
    }

    /// The profile is a CMS envelope around an XML plist; the plist is read from its own bytes.
    static func apsEnvironment(_ profile: Data) -> String? {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound], format: nil),
              let entitlements = (plist as? [String: Any])?["Entitlements"] as? [String: Any] else { return nil }
        return entitlements["aps-environment"] as? String
    }
}
