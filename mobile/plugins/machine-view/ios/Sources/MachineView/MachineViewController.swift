/// The machine window: one machine's yaran web UI in a bridge-less WKWebView, full screen.
///
/// Wires the WebView (`WebViewFactory`), the policies (`NavigationDelegate`, `UIDelegate`),
/// the session cookie (`CookieInjector`, re-injected before every load and on every resume),
/// renewal (`RenewalCoordinator` and the handoff client), the native overlays and banner, the
/// App Lock and screen-privacy covers, renderer-crash recovery, and the close reasons the
/// shell routes on.
///
/// - Main actor. Every iPad orientation, Split View and Stage Manager size: a size change is a
///   layout pass, never a reload. Not compiled on this machine (UIKit).
/// - Opening, resuming and renewal wait while App Lock is engaged (`LockGate`), and run once
///   at the unlock the core's own lock notification reports. A resume while a renewal's
///   sign-in is out waits for it, and a WebContent crash behind the lock reloads at the unlock.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewController
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/OverlayView (inferred)
/// ├── MachineView/UIDelegate (inferred)
/// ├── MachineView/WebViewFactory (inferred)
/// ├── MachineViewCore/CookieInjector (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/LockGate (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/RefusalPolicy (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCore/RenewalPolicy (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: UIKit, WebKit
///
/// Used by:
/// MachineView/MachineViewController
/// └── MachineView/MachineViewPlugin (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

@MainActor
final class MachineViewController: UIViewController, @preconcurrency RenewalUi {
    struct Target { let orgId: String, machineId: String, host: String, route: String? }

    let target: Target
    private let services: AppServices
    private let onClosed: (String, String?) -> Void
    private var webView: WKWebView!
    private var navigation: NavigationDelegate!
    private var uiDelegate: UIDelegate!
    private var coordinator: RenewalCoordinator!
    private let scheduler = MainScheduler()
    private var overlay: OverlayView?
    private var banner: OverlayView?
    private var lockCover: CoverView?
    private var privacyCover: CoverView?
    private var lastUrl: URL
    private var started = false
    private var closed = false
    private var gate = LockGate()
    private var locked: Bool { CoreBindings.appLock?.isLocked() == true }

    init(target: Target, services: AppServices, onClosed: @escaping (String, String?) -> Void) {
        self.target = target
        self.services = services
        self.onClosed = onClosed
        lastUrl = URL(string: "https://\(target.host)/\(target.route ?? "")")!
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        isModalInPresentation = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    private var vars: [String: String] {
        ["machine": target.host, "host": target.host, "email": (try? services.sessions.get(target.host))?.email ?? ""]
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background
        webView = WebViewFactory.make(host: target.host, uaToken: services.uaToken)
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.pin(webView)
        navigation = NavigationDelegate(pinnedHost: target.host, diagnostics: services.diagnostics)
        uiDelegate = UIDelegate(navigation: navigation)
        webView.navigationDelegate = navigation
        webView.uiDelegate = uiDelegate
        wireNavigation()
        coordinator = RenewalCoordinator(clock: AppServices.now, scheduler: scheduler, session: { [weak self] in
            guard let self, let stored = try? self.services.sessions.get(self.target.host) else { return nil }
            return (iat: stored.iat, exp: stored.exp)
        }, ui: self, renew: { [weak self] done in
            guard let self else { return }
            self.services.handoff.signIn(orgId: self.target.orgId, request: .machine(host: self.target.host), completion: done)
        })
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(lockStateDidChange), name: CoreAdapters.lockStateChanged, object: nil)
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (self: Self, _: UITraitCollection) in self.updatePrivacyCover() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        updateLockCover()
        run(gate.appeared(locked: locked))
    }

    private func wireNavigation() {
        navigation.onAction = { [weak self] decision, url in
            guard let self else { return }
            switch decision {
            case .reauth: self.coordinator.onReauthSignal()
            case .closeHome: self.close("home")
            case .closeSettings: self.close("settings")
            case .external: UIApplication.shared.open(url)
            case .allow, .allowInPlace, .block, .ignore: break
            }
        }
        navigation.onRefusal = { [weak self] verdict, code in self?.showRefusal(verdict, code: code) }
        navigation.onDownloadRefused = { [weak self] in self?.toast("download_refused") }
        navigation.onLoadFailure = { [weak self] failure in
            switch failure {
            case .tls: self?.showOverlay("tls_error")
            case .offline: self?.showOverlay("offline")
            }
        }
        navigation.onContentProcessTerminated = { [weak self] in
            // Behind the lock nothing loads: the gate's pending open or resume reloads at the unlock.
            guard let self, !self.locked else { return }
            self.toast("renderer_crashed")
            self.loadCurrent()
        }
        navigation.onCommitted = { [weak self] url in self?.lastUrl = url }
    }

    // MARK: loading

    private func run(_ step: LockGate.Step) {
        switch step {
        case .none: break
        case .open: open(context: .open)
        case .resume: open(context: .resume)
        }
    }

    private func open(context: RenewalContext) {
        let decision = context == .open ? coordinator.onOpen() : coordinator.onResume()
        switch decision {
        case .load: loadCurrent()
        case .wait: break // back from Mail or an authenticator mid sign-in: that renewal reloads
        case .renewFirst:
            coordinator.renewNow { [weak self] outcome in
                guard let self else { return }
                if case .signedIn = outcome { return } // renewNow already re-injected and reloaded
                self.showReauthOverlay()
                self.toastSignIn(outcome)
            }
        }
        coordinator.onVisibilityChanged(true)
    }

    /// Re-injects the cookie, then loads the page's last same-host URL.
    private func loadCurrent() {
        inject { [weak self] injected in
            guard let self else { return }
            if injected { self.webView.load(URLRequest(url: self.lastUrl)) } else { self.coordinator.onReauthSignal() }
        }
    }

    private func inject(_ done: @escaping (Bool) -> Void) {
        guard let session = try? services.sessions.get(target.host),
              let cookie = try? CookieSpec.make(kind: session.credentialKind, jwt: session.jwt, cookie: session.cookie) else {
            return done(false)
        }
        if cookie.diagnostic { services.diagnostics?.append(diagLine("cookie rung without cookie field", [("host", target.host)])) }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        Task { @MainActor in
            let visible = await CookieInjector.inject(cookie, host: self.target.host, into: store)
            if !visible { self.services.diagnostics?.append(diagLine("cookie not visible after inject", [("host", self.target.host)])) }
            done(visible)
        }
    }

    // MARK: overlays

    private func showRefusal(_ verdict: RefusalVerdict, code: String?) {
        switch verdict.decision {
        case .none: break
        case .reauth: coordinator.onReauthSignal()
        case .notOwner: showOverlay("not_owner")
        case .keysUnavailable: showOverlay("keys_unavailable")
        case .unavailable: showOverlay("unavailable")
        case .hostDisconnected: showOverlay("host_disconnected")
        case .codeOverlay: showOverlay("code_overlay", extra: ["code": code ?? "-"])
        case .offline: showOverlay("offline")
        }
    }

    private func showOverlay(_ key: String, extra: [String: String] = [:]) {
        overlay?.removeFromSuperview()
        let shown = OverlayView.overlay(key, vars: vars.merging(extra) { $1 }) { [weak self] action in self?.perform(action) }
        view.pin(shown)
        overlay = shown
        bringCoversToFront()
        UIAccessibility.post(notification: .screenChanged, argument: shown)
    }

    private func perform(_ action: String) {
        guard !locked else { return } // nothing behind the lock cover may act
        switch action {
        case "sign_in", "renew":
            coordinator.renewNow { [weak self] outcome in
                if case .signedIn = outcome { return }
                self?.toastSignIn(outcome)
            }
        case "back_to_machines": close("user")
        case "retry":
            hideOverlay()
            loadCurrent()
        default: close("user")
        }
    }

    private func toast(_ key: String) { view.toast(Messages.fill(Messages.overlay[key]?.message ?? key, vars)) }

    private func toastSignIn(_ outcome: SignInOutcome) {
        var values = vars
        if case .verificationFailed(let domain) = outcome { values["domain"] = domain }
        if case .refused(let code) = outcome { values["code"] = code }
        if case .deviceKeyRejected(let code, _) = outcome { values["code"] = code }
        if case .decryptFailed(let code) = outcome { values["code"] = code }
        view.toast(Messages.fill(Messages.signIn[outcome.kind]?.message ?? outcome.kind, values))
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
    func reloadSameUrl() { loadCurrent() }

    // MARK: lifecycle, lock and privacy

    @objc private func willResignActive() {
        if CoreBindings.screenPrivacy?.enabled() == true { setPrivacyCover(true) }
    }

    @objc private func didBecomeActive() {
        updatePrivacyCover()
        updateLockCover()
        guard started, !closed else { return }
        run(gate.becameActive(locked: locked))
    }

    @objc private func didEnterBackground() {
        coordinator.onVisibilityChanged(false)
        gate.enteredBackground()
    }

    /// Posted on whatever thread changed the lock (the unlock's Keychain read runs off main).
    @objc private nonisolated func lockStateDidChange() {
        Task { @MainActor [weak self] in self?.lockChanged() }
    }

    private func lockChanged() {
        updateLockCover()
        guard started, !closed else { return }
        run(gate.lockChanged(locked: locked))
    }

    private func updateLockCover() {
        if locked, lockCover == nil {
            let cover = CoverView()
            view.pin(cover)
            lockCover = cover
        } else if !locked {
            lockCover?.removeFromSuperview()
            lockCover = nil
        }
    }

    private func updatePrivacyCover() {
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
    }

    private func bringCoversToFront() {
        [lockCover, privacyCover].compactMap { $0 }.forEach { view.bringSubviewToFront($0) }
    }

    // MARK: closing

    func close(_ reason: String, code: String? = nil) {
        guard !closed else { return }
        closed = true
        coordinator.onVisibilityChanged(false)
        // Lifecycle and lock events must stop at close, not when the dismissal ends and deinit runs.
        // swiftlint:disable:next notification_center_detachment
        NotificationCenter.default.removeObserver(self)
        webView.stopLoading()
        dismiss(animated: true) { [onClosed] in onClosed(reason, code) }
    }
}

/// Wall-clock one-shot timers; a timer that slept through the background is re-checked on resume.
@MainActor
final class MainScheduler: @preconcurrency OneShotScheduler {
    final class Token: Cancellable {
        var timer: Timer?
        func cancel() { timer?.invalidate() }
    }

    func schedule(at second: Int64, _ fire: @escaping () -> Void) -> Cancellable {
        let token = Token()
        let delay = max(0, Double(second) - Date().timeIntervalSince1970)
        token.timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated { fire() }
        }
        return token
    }
}
