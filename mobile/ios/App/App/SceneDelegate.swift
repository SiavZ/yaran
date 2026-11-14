/// SceneDelegate: builds the one window around Capacitor's bridge and guards it.
///
/// Forwards connection, URL opens (`yaranapp://add-org`) and user activities to Capacitor's
/// `SceneDelegateProxy`. It also attaches the core's `PrivacyCover` (app-switcher and capture
/// cover, and the lock cover) and feeds the scene lifecycle to `AppLock`, which engages the
/// lock again once the grace period has run out in the background.
///
/// - Main thread only; owns the window.
///
/// <module-headers:begin>
/// Uses:
/// App/SceneDelegate
/// ├── YaranCore/AppLock (inferred)
/// └── YaranCore/ScreenPrivacy (inferred)
/// External: Capacitor, UIKit
///
/// Used by:
/// App/SceneDelegate
/// └── App/AppDelegate (inferred)
/// <module-headers:end>

import Capacitor
import UIKit
import YaranCore

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = CAPBridgeViewController()
        window.makeKeyAndVisible()
        self.window = window
        AppLock.shared.prompt = NSLocalizedString("lock.prompt", value: "Unlock yaran", comment: "Keychain prompt")
        PrivacyCover.shared.attach(to: window)
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        PrivacyCover.shared.sceneWillResignActive()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        PrivacyCover.shared.sceneDidBecomeActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        AppLock.shared.didEnterBackground(nowMs: Self.nowMs())
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        AppLock.shared.willEnterForeground(nowMs: Self.nowMs())
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
