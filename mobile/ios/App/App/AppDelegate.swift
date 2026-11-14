/// AppDelegate: the yaran app's application delegate (Capacitor 8 scene template).
///
/// The app uses the scene lifecycle, so UIKit sends resign, background and foreground events
/// to `SceneDelegate`, which is where the screen-privacy cover and the lock gate live; this
/// delegate hands every scene to it. At launch it binds the machine-view plugin to the core and
/// the push plugin to Phase 15's org client, and it forwards the APNs token and background
/// pushes (cleared events) to the push plugin.
///
/// - Main thread only; keeps no state of its own.
///
/// <module-headers:begin>
/// Uses:
/// App/AppDelegate
/// ├── App/SceneDelegate (inferred)
/// ├── MachineView/NativeOrgApi (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── PushPlugin/PushPlugin (inferred)
/// └── YaranPushRegistration/OrgApiGateway (inferred)
/// External: UIKit
///
/// Used by: entry point (@main, the iOS app entry of mobile/ios/App/App.xcodeproj)
/// <module-headers:end>

import MachineView
import MachineViewCore
import PushPlugin
import UIKit
import YaranPushRegistration

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        CoreAdapters.installDefault()
        PushPlugin.orgApi = PushOrgGateway()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        PushPlugin.handleBackgroundPush(userInfo: userInfo, completion: completionHandler)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// The push plugin's W12 gateway over Phase 15's native org client (`NativeOrgApi`).
struct PushOrgGateway: OrgApiGateway {
    func devicePublicKey(orgId: String) async throws -> String {
        try await NativeOrgApi.devicePublicKey(orgId: orgId)
    }

    func registerDevice(orgId: String, body: Data) async -> OrgApiResult {
        switch await NativeOrgApi.request(orgId: orgId, method: "POST", path: "/v1/me/devices", body: body) {
        case .ok(let status, let json):
            let data = (try? JSONSerialization.data(withJSONObject: json ?? NSNull(), options: [.fragmentsAllowed])) ?? Data()
            return .ok(status: status, body: data)
        case .apiError(let status, let error):
            return .apiError(status: status, code: (error["error"] as? [String: Any])?["code"] as? String ?? "unknown")
        case .sessionExpired: return .sessionExpired
        case .deviceRevoked: return .deviceRevoked
        case .offline: return .offline
        case .tlsError: return .tlsError
        case .refused: return .refused
        case .protocolUnsupported: return .protocolUnsupported
        }
    }
}
