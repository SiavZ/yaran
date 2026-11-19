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
/// ├── MachineView/MachineViewPlugin (inferred)
/// ├── YaranCore/AppLock (inferred)
/// └── YaranCore/ScreenPrivacy (inferred)
/// External: Capacitor, Darwin, UIKit
///
/// Used by:
/// App/SceneDelegate
/// └── App/AppDelegate (inferred)
/// <module-headers:end>

import Capacitor
import Darwin
import MachineView
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
        // A cold start (G5): shared files are held natively and JS hears a count; links and user
        // activities reach the shell as Capacitor's proxy would deliver them, never a file URL.
        ShareIntake.connect(scene, options: connectionOptions)
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

    /// Shared files (G5) stay native; every other URL (add-org, add-machine) goes to the shell.
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        let files = URLContexts.filter(\.url.isFileURL)
        ShareIntake.receive(files.map(\.url))
        let links = URLContexts.subtracting(files)
        if !links.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: links) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    private static func nowMs() -> Int64 {
        Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)
    }
}
