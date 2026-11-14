/// SceneDelegate: builds the spike's window around GateSpikeViewController.
///
/// Forwards scene connection, URL opens and user activities to Capacitor's
/// SceneDelegateProxy, so the deep-link and universal-link callbacks the gates test reach
/// the bridge.
///
/// - Main thread only; owns the one window.
///
/// <module-headers:begin>
/// Uses:
/// App/SceneDelegate
/// └── App/GateSpikeViewController (inferred)
/// External: Capacitor, UIKit
///
/// Used by:
/// App/SceneDelegate
/// └── App/AppDelegate (inferred)
/// <module-headers:end>

import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = GateSpikeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
