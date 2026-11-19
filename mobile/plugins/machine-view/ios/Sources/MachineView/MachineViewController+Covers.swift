/// The machine window's lifecycle, App Lock and screen-privacy covers.
///
/// Split from `MachineViewController.swift` by concern.
///
/// - Main actor, like the window. Not compiled on this machine (UIKit).
/// - While any cover obscures the page (App Lock, or the screen-privacy cover during capture
///   and in the app switcher) the WebView is detached from the window, so the page reports
///   itself hidden; it comes back only when no cover is up (`CoverState`). Opening, resuming and renewal wait while App Lock is engaged (`LockGate`), and run once
///   at the unlock the core's own lock notification reports. A resume while a renewal's
///   sign-in is out waits for it, and a WebContent crash behind the lock reloads at the unlock.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewController+Covers
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/OverlayView (inferred)
/// ├── MachineViewCore/CoverState (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: UIKit, WebKit
///
/// Used by: entry point (a Swift extension of MachineViewController, compiled into the MachineView module (no import names it))
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

extension MachineViewController {
    @objc func willResignActive() {
        if CoreBindings.screenPrivacy?.enabled() == true { setPrivacyCover(true) }
    }

    @objc func didBecomeActive() {
        updatePrivacyCover()
        updateLockCover()
        guard started, !closed else { return }
        run(gate.becameActive(locked: locked))
    }

    @objc func didEnterBackground() {
        coordinator.onVisibilityChanged(false)
        gate.enteredBackground()
        backgroundedAt = Date()
    }

    /// Posted on whatever thread changed the lock (the unlock's Keychain read runs off main).
    @objc nonisolated func lockStateDidChange() {
        Task { @MainActor [weak self] in self?.lockChanged() }
    }

    private func lockChanged() {
        updateLockCover()
        guard started, !closed else { return }
        run(gate.lockChanged(locked: locked))
    }

    /// WebKit counts a page visible while its view is in a window and the app is not in the
    /// background (`isHidden` is not an input), so any cover that obscures the page takes the
    /// WebView out of the window, which turns `document.visibilityState` hidden and stops the
    /// viewed beat. It returns only when no cover is up. A WebContent crash meanwhile keeps the
    /// same `WKWebView`, so it stays out.
    func updateLockCover() {
        if locked, lockCover == nil {
            let cover = CoverView()
            view.pin(cover)
            lockCover = cover
        } else if !locked {
            lockCover?.removeFromSuperview()
            lockCover = nil
        }
        applyCovers(covers.set(lock: locked))
    }

    func updatePrivacyCover() {
        let capturing = traitCollection.sceneCaptureState == .active
        setPrivacyCover(CoreBindings.screenPrivacy?.enabled() == true && capturing)
    }

    private func setPrivacyCover(_ shown: Bool) {
        if shown, privacyCover == nil {
            let cover = CoverView()
            view.pin(cover)
            privacyCover = cover
        } else if !shown {
            privacyCover?.removeFromSuperview()
            privacyCover = nil
        }
        applyCovers(covers.set(privacy: shown))
    }

    private func applyCovers(_ change: CoverState.Change) {
        guard let webView else { return }
        switch change {
        case .detach: webView.removeFromSuperview()
        case .attach:
            if webView.superview == nil {
                view.pin(webView)
                view.sendSubviewToBack(webView)
            }
        case .none: break
        }
    }

    func bringCoversToFront() {
        [lockCover, privacyCover].compactMap { $0 }.forEach { view.bringSubviewToFront($0) }
    }
}
