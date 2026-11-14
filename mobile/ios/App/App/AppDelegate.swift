/// AppDelegate: the yaran app's application delegate (Capacitor 8 scene template).
///
/// The app uses the scene lifecycle, so UIKit sends resign, background and foreground events
/// to `SceneDelegate`, which is where the screen-privacy cover and the lock gate live; this
/// delegate hands every scene to it and, at launch, binds the machine-view plugin to the core.
///
/// - Main thread only; keeps no state of its own.
///
/// <module-headers:begin>
/// Uses:
/// App/AppDelegate
/// ├── App/SceneDelegate (inferred)
/// └── MachineViewCore/CoreAdapters (inferred)
/// External: UIKit
///
/// Used by: entry point (@main, the iOS app entry of mobile/ios/App/App.xcodeproj)
/// <module-headers:end>

import MachineViewCore
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        CoreAdapters.installDefault()
        return true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
