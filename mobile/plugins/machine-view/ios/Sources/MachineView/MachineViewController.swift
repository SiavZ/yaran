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

    /// Phase 14 posts this when App Lock locks or unlocks (assumed name).
    static let appLockChanged = Notification.Name("YaranAppLockStateChanged")

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
            guard let self, let s = try? self.services.sessions.get(self.target.host) else { return nil }
            return (iat: s.iat, exp: s.exp)
        }, ui: self, renew: { [weak self] done in
            guard let self else { return }
            self.services.handoff.signIn(orgId: self.target.orgId, request: .machine(host: self.target.host), completion: done)
        })
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(updateLockCover), name: Self.appLockChanged, object: nil)
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (self: Self, _: UITraitCollection) in self.updatePrivacyCover() }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        updateLockCover()
        open(context: .open)
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
            self?.toast("renderer_crashed")
            self?.loadCurrent()
        }
        navigation.onCommitted = { [weak self] url in self?.lastUrl = url }
    }

    // MARK: loading

    private func open(context: RenewalContext) {
        let decision = context == .open ? coordinator.onOpen() : coordinator.onResume()
        switch decision {
        case .load: loadCurrent()
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
        inject { [weak self] ok in
            guard let self else { return }
            if ok { self.webView.load(URLRequest(url: self.lastUrl)) } else { self.coordinator.onReauthSignal() }
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
            let ok = await CookieInjector.inject(cookie, host: self.target.host, into: store)
            if !ok { self.services.diagnostics?.append(diagLine("cookie not visible after inject", [("host", self.target.host)])) }
            done(ok)
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
        let o = OverlayView.overlay(key, vars: vars.merging(extra) { $1 }) { [weak self] action in self?.perform(action) }
        view.pin(o)
        overlay = o
        bringCoversToFront()
        UIAccessibility.post(notification: .screenChanged, argument: o)
    }

    private func perform(_ action: String) {
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
        var v = vars
        if case .verificationFailed(let domain) = outcome { v["domain"] = domain }
        if case .refused(let code) = outcome { v["code"] = code }
        if case .deviceKeyRejected(let code, _) = outcome { v["code"] = code }
        if case .decryptFailed(let code) = outcome { v["code"] = code }
        view.toast(Messages.fill(Messages.signIn[outcome.kind]?.message ?? outcome.kind, v))
    }

    // MARK: RenewalUi

    func showBanner() {
        guard banner == nil else { return }
        let b = OverlayView.overlay("banner", vars: vars, style: .banner) { [weak self] action in self?.perform(action) }
        view.addSubview(b)
        NSLayoutConstraint.activate([
            b.topAnchor.constraint(equalTo: view.topAnchor), b.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            b.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        banner = b
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
        open(context: .resume)
    }

    @objc private func didEnterBackground() { coordinator.onVisibilityChanged(false) }

    @objc private func updateLockCover() {
        let locked = CoreBindings.appLock?.isLocked() == true
        if locked, lockCover == nil {
            let c = CoverView()
            view.pin(c)
            lockCover = c
        } else if !locked {
            lockCover?.removeFromSuperview()
            lockCover = nil
        }
    }

    private func updatePrivacyCover() {
        let capturing = traitCollection.sceneCaptureState == .active
        setPrivacyCover(CoreBindings.screenPrivacy?.enabled() == true && capturing)
    }

    private func setPrivacyCover(_ on: Bool) {
        if on, privacyCover == nil {
            let c = CoverView()
            view.pin(c)
            privacyCover = c
        } else if !on {
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

    func schedule(at: Int64, _ fire: @escaping () -> Void) -> Cancellable {
        let token = Token()
        let delay = max(0, Double(at) - Date().timeIntervalSince1970)
        token.timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated { fire() }
        }
        return token
    }
}
