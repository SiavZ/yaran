/// The machine window's native overlays, toasts and banners, and its `RenewalUi` half.
///
/// Split from `MachineViewController.swift` by concern: the overlay actions the user takes
/// (sign in, retry, another route, discard a share, back to machines) and what renewal shows.
///
/// - Main actor, like the window. Not compiled on this machine (UIKit).
/// - Nothing behind the lock cover acts: an overlay action while locked is dropped.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewController+Overlays
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/OverlayView (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// └── MachineViewCore/RefusalPolicy (inferred)
/// External: UIKit
///
/// Used by: entry point (a Swift extension of MachineViewController, compiled into the MachineView module (no import names it))
/// <module-headers:end>
import MachineViewCore
import UIKit

extension MachineViewController {
    func showRefusal(_ verdict: RefusalVerdict, code: String?) {
        switch verdict.decision {
        case .none: break
        case .reauth: reauthSignal()
        case .notOwner: showOverlay("not_owner")
        case .keysUnavailable: showOverlay("keys_unavailable")
        case .unavailable: showOverlay("unavailable")
        case .hostDisconnected: showOverlay("host_disconnected")
        case .codeOverlay: showOverlay("code_overlay", extra: ["code": code ?? "-"])
        case .offline: showOverlay("offline")
        }
    }

    func reauthSignal() { if orgRoute != nil { coordinator.onReauthSignal() } else { showOverlay("reauth") } }

    func showOverlay(_ key: String, extra: [String: String] = [:], detail: String? = nil) {
        overlay?.removeFromSuperview()
        let shown = OverlayView.overlay(key, vars: vars.merging(extra) { $1 }, detail: detail) { [weak self] action in self?.perform(action) }
        view.pin(shown)
        overlay = shown
        bringCoversToFront()
        UIAccessibility.post(notification: .screenChanged, argument: shown)
    }

    private func perform(_ action: String) {
        guard !locked else { return } // nothing behind the lock cover may act
        switch action {
        case "sign_in", "renew":
            guard orgRoute != nil else { return directSignIn() }
            let owned = tenure.check()
            coordinator.renewNow { [weak self] outcome in
                guard owned() else { return }
                if case .signedIn = outcome { return }
                self?.toastSignIn(outcome)
            }
        case "back_to_machines": close("user")
        case "retry":
            hideOverlay()
            if target.kind == "org" { loadCurrent() } else { select(current: webView.url == nil ? nil : chosen, retry: true) }
        case "try_another_route":
            hideOverlay()
            select(current: chosen, retry: true)
        case "discard": discardShare()
        default: close("user")
        }
    }

    func toast(_ key: String) { view.toast(Messages.fill(Messages.overlay[key]?.message ?? key, vars)) }

    func toastSignIn(_ outcome: SignInOutcome) {
        var values = vars
        if case .verificationFailed(let domain) = outcome { values["domain"] = domain }
        if case .refused(let code) = outcome { values["code"] = code }
        if case .deviceKeyRejected(let code, _) = outcome { values["code"] = code }
        if case .decryptFailed(let code) = outcome { values["code"] = code }
        view.toast(Messages.fill(Messages.signIn[outcome.kind]?.message ?? outcome.kind, values))
    }

    func showShareBanner() {
        shareBanner?.removeFromSuperview()
        shareBanner = nil
        guard !shared.isEmpty else { return }
        let bannerView = OverlayView.overlay("share_ready", vars: vars.merging(["count": String(shared.count)]) { $1 }, style: .banner) { [weak self] in
            self?.perform($0)
        }
        view.addSubview(bannerView)
        NSLayoutConstraint.activate([
            bannerView.bottomAnchor.constraint(equalTo: view.bottomAnchor), bannerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bannerView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        shareBanner = bannerView
        bringCoversToFront()
    }

    // MARK: RenewalUi

    func showBanner() {
        guard banner == nil else { return }
        let bannerView = OverlayView.overlay("banner", vars: vars, style: .banner) { [weak self] action in self?.perform(action) }
        view.addSubview(bannerView)
        NSLayoutConstraint.activate([
            bannerView.topAnchor.constraint(equalTo: view.topAnchor), bannerView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bannerView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        banner = bannerView
        bringCoversToFront()
    }

    func hideBanner() { banner?.removeFromSuperview(); banner = nil }
    func showReauthOverlay() { showOverlay("reauth") }
    func hideOverlay() { overlay?.removeFromSuperview(); overlay = nil }
    /// After a renewal: a routed window checks the route's instance again before anything loads.
    func reloadSameUrl() { if target.kind == "routes" { select(current: chosen, retry: true) } else { loadCurrent() } }
}
