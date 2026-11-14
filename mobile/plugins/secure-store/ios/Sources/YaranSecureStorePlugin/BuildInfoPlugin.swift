/// BuildInfoPlugin: the `BuildInfo` bridge object, reporting compiled build facts.
///
/// iOS has one store channel, so `flavor` is always `appstore`. `e2e` and the e2e control
/// plane URL come from Info.plist keys filled by build settings (`YaranE2E` from the E2E
/// configuration, `YaranE2EControlPlaneURL` from the generated E2E.xcconfig), because a Swift
/// package does not see the App target's compilation conditions. Both are empty elsewhere.
///
/// - Phase 19 hook H6: only the E2E configuration can report `e2e: true`.
///
/// <module-headers:begin>
/// Uses: none
/// External: Capacitor, Foundation
///
/// Used by: none
/// <module-headers:end>

import Capacitor
import Foundation
import YaranCore

@objc(BuildInfoPlugin)
public class BuildInfoPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BuildInfoPlugin"
    public let jsName = "BuildInfo"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise)
    ]

    @objc func get(_ call: CAPPluginCall) {
        call.run {
            let info = Bundle.main.infoDictionary ?? [:]
            let e2e = info["YaranE2E"] as? String == "YES"
            return [
                "flavor": "appstore",
                "e2e": e2e,
                "e2eControlPlaneUrl": e2e ? (info["YaranE2EControlPlaneURL"] as? String ?? "") : "",
            ]
        }
    }
}
