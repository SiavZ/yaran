/// ScreenPrivacy: the native cover that hides the app in the app switcher, while the screen is
/// being captured, and while the app lock is engaged (iOS).
///
/// One cover view serves both jobs. It goes up before the app-switcher snapshot is taken
/// (scene resign), while `sceneCaptureState` is active (iOS 17+ trait), and whenever
/// `AppLock` is locked; in the locked state it carries the Unlock button, because the shell
/// underneath cannot be touched until the Keychain read succeeds.
///
/// - The setting persists in UserDefaults (not a secret), so the next launch applies it before
///   the shell loads.
/// - `shouldCover` is the pure rule; the UIKit part sits behind `#if canImport(UIKit)` so the
///   package still builds and tests on macOS.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/ScreenPrivacy
/// └── YaranCore/AppLock (inferred)
/// External: Foundation, UIKit
///
/// Used by:
/// YaranCore/ScreenPrivacy
/// ├── App/SceneDelegate (inferred)
/// ├── YaranCoreTests/PluginArgumentsTests (inferred)
/// └── YaranSecureStorePlugin/ScreenPrivacyPlugin (inferred)
/// <module-headers:end>

import Foundation
#if canImport(UIKit)
import UIKit
#endif

public enum ScreenPrivacy {
    private static let defaultsKey = "io.github.siavz.yaran.screenPrivacy"

    public static var isEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: defaultsKey) }
        set { UserDefaults.standard.set(newValue, forKey: defaultsKey) }
    }

    /// The lock always covers; privacy covers an inactive or captured scene when it is on.
    public static func shouldCover(enabled: Bool, inactive: Bool, captured: Bool, locked: Bool) -> Bool {
        locked || (enabled && (inactive || captured))
    }
}

#if canImport(UIKit)
@MainActor
public final class PrivacyCover {
    public static let shared = PrivacyCover()

    private weak var window: UIWindow?
    private var inactive = false
    private var captured = false
    private var observer: NSObjectProtocol?
    private lazy var cover = makeCover()
    private lazy var unlockButton = makeUnlockButton()

    /// Starts covering `window`: follows capture state and the lock.
    public func attach(to window: UIWindow) {
        self.window = window
        window.registerForTraitChanges([UITraitSceneCaptureState.self]) { [weak self] (window: UIWindow, _) in
            self?.captured = window.traitCollection.sceneCaptureState == .active
            self?.update()
        }
        captured = window.traitCollection.sceneCaptureState == .active
        observer = NotificationCenter.default.addObserver(
            forName: AppLock.lockStateChanged, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.update() }
        }
        update()
    }

    /// Scene resign: the app-switcher snapshot is taken right after this returns.
    public func sceneWillResignActive() {
        inactive = true
        update()
    }

    public func sceneDidBecomeActive() {
        inactive = false
        update()
    }

    /// Re-applies the rule (after the setting changes).
    public func update() {
        guard let window else { return }
        let locked = AppLock.shared.locked
        let show = ScreenPrivacy.shouldCover(enabled: ScreenPrivacy.isEnabled, inactive: inactive,
                                             captured: captured, locked: locked)
        unlockButton.isHidden = !locked || inactive
        if show {
            cover.frame = window.bounds
            if cover.superview !== window { window.addSubview(cover) }
            window.bringSubviewToFront(cover)
        } else {
            cover.removeFromSuperview()
        }
    }

    private func makeCover() -> UIView {
        let view = UIView()
        view.backgroundColor = UIColor(named: "YaranBackground") ?? .black
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.accessibilityViewIsModal = true
        unlockButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(unlockButton)
        NSLayoutConstraint.activate([
            unlockButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            unlockButton.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            unlockButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
        return view
    }

    private func makeUnlockButton() -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = NSLocalizedString("lock.unlock", bundle: .main, value: "Unlock", comment: "Lock cover button")
        config.baseBackgroundColor = UIColor(named: "YaranPrimary")
        config.baseForegroundColor = UIColor(named: "YaranPrimaryForeground")
        let button = UIButton(configuration: config)
        button.addAction(UIAction { _ in
            // The Keychain read blocks while Face ID runs, so it never runs on the main thread.
            DispatchQueue.global(qos: .userInitiated).async { _ = try? AppLock.shared.unlock() }
        }, for: .primaryActionTriggered)
        return button
    }
}
#endif
