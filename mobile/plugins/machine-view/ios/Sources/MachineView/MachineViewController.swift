/// The machine window: one machine's yaran web UI in a bridge-less WKWebView, full screen.
///
/// Wires the WebView (`WebViewFactory`), the policies (`NavigationDelegate`, `UIDelegate`),
/// the session cookie (`CookieInjector`, re-injected before every load and on every resume),
/// renewal (`RenewalCoordinator` and the handoff client) for org routes, the native overlays
/// and banner, the App Lock and screen-privacy covers, renderer-crash recovery, and the close
/// reasons the shell routes on. Direct routes, route choice and shared files are the
/// `+Direct` half (G1, G2, G5); the lifecycle and the covers are the `+Covers` half, and the
/// overlays, banners and `RenewalUi` the `+Overlays` half.
///
/// - Main actor. Every iPad orientation, Split View and Stage Manager size: a size change is a
///   layout pass, never a reload. Not compiled on this machine (UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewController
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MainScheduler (inferred)
/// ├── MachineView/OverlayView (inferred)
/// ├── MachineView/UIDelegate (inferred)
/// ├── MachineView/WebViewFactory (inferred)
/// ├── MachineViewCore/CookieInjector (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/CoverState (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/LockGate (inferred)
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// ├── MachineViewCore/PendingChooser (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCore/RenewalPolicy (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: UIKit, WebKit
///
/// Used by:
/// MachineView/MachineViewController
/// ├── MachineView/MachineViewController+Covers (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineView/MachineViewController+Overlays (inferred)
/// └── MachineView/MachineViewPlugin (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

@MainActor
final class MachineViewController: UIViewController, @preconcurrency RenewalUi {
    struct Target {
        let kind: String
        let routes: [MachineRoute]
        let instance: String?
        let route: String?
        let shared: [URL]
    }

    let target: Target
    let services: AppServices
    private let onClosed: ([String: Any]) -> Void
    var webView: WKWebView!
    private var navigation: NavigationDelegate!
    private var uiDelegate: UIDelegate!
    var coordinator: RenewalCoordinator!
    private let scheduler = MainScheduler()
    // Internal, not private: the overlays half (`+Overlays`) owns these views.
    var overlay: OverlayView?
    var banner: OverlayView?
    var shareBanner: OverlayView?
    // Internal, not private: the covers half (`+Covers`) reads and sets these.
    var lockCover: CoverView?
    var privacyCover: CoverView?
    var covers = CoverState()
    var lastUrl: URL
    var chosen = 0
    var shared: [URL]
    var backgroundedAt: Date?
    /// The instance the chosen direct route answered at its last probe; only its own record is used.
    var observed: String?
    /// The sign-in this window itself just made: usable before a probe can bind it.
    var fresh: String?
    var reloads = PageReload()
    var started = false
    /// Once true, no continuation of this window (a probe, a read, a sign-in, an injection) acts.
    var closed: Bool { tenure.closed }
    /// Which route this window's pending work belongs to; a route switch or the close ends it.
    let tenure = RouteTenure()
    /// The page's file chooser and the route's password sheet waiting on the user, if any.
    let prompts = OpenPrompts()
    var gate = LockGate()
    var locked: Bool { CoreBindings.appLock?.isLocked() == true }
    var host: String { target.routes[chosen].host }
    var orgRoute: (orgId: String, host: String)? {
        if case let .org(orgId, _, host) = target.routes[chosen] { return (orgId, host) }
        return nil
    }

    init(target: Target, services: AppServices, onClosed: @escaping ([String: Any]) -> Void) {
        self.target = target
        self.services = services
        self.onClosed = onClosed
        shared = target.shared
        lastUrl = URL(string: "https://\(target.routes[0].host)/\(target.route ?? "")")!
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        isModalInPresentation = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    var vars: [String: String] {
        ["machine": host, "host": host, "email": orgRoute.flatMap { try? services.sessions.get($0.host, orgId: $0.orgId) }?.email ?? ""]
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background
        makeWebView()
        coordinator = RenewalCoordinator(clock: AppServices.now, scheduler: scheduler, session: { [weak self] in
            guard let self, let org = self.orgRoute, let stored = try? self.services.sessions.get(org.host, orgId: org.orgId) else { return nil }
            return (iat: stored.iat, exp: stored.exp)
        }, ui: self, renew: { [weak self] done in
            guard let self, let org = self.orgRoute else { return done(.cancelled) } // direct routes never renew here
            self.services.handoff.signIn(orgId: org.orgId, request: .machine(host: org.host), completion: done)
        })
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(willResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(lockStateDidChange), name: CoreAdapters.lockStateChanged, object: nil)
        registerForTraitChanges([UITraitSceneCaptureState.self]) { (self: Self, _: UITraitCollection) in self.updatePrivacyCover() }
        showShareBanner()
    }

    /// A WebView for the current route's host; a route switch makes a new one, never reuses one.
    func makeWebView() {
        webView = WebViewFactory.make(host: host, uaToken: services.uaToken)
        webView.translatesAutoresizingMaskIntoConstraints = false
        if covers.pageAttached {
            view.pin(webView)
            view.sendSubviewToBack(webView)
        }
        navigation = NavigationDelegate(pinnedHost: host, diagnostics: services.diagnostics)
        navigation.admitDocument = admissionHook
        uiDelegate = UIDelegate(navigation: navigation)
        webView.navigationDelegate = navigation
        applyUiDelegate()
        wireNavigation()
    }

    /// WebKit reads which delegate methods exist when the delegate is set, so the open-panel
    /// delegate is set only while shared files are held; otherwise WebKit's own picker runs.
    func applyUiDelegate() {
        if #available(iOS 18.4, *), !shared.isEmpty {
            uiDelegate = ShareUIDelegate(navigation: navigation) { [weak self] multiple, done in self?.offerShare(multiple: multiple, done) }
        } else {
            uiDelegate = UIDelegate(navigation: navigation)
        }
        webView.uiDelegate = uiDelegate
    }

    func dropWebView() {
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
        webView.removeFromSuperview()
        webView = nil
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
            // A direct machine has no Access session to renew: Access in front means it belongs to an org.
            // The page's own Sign in (the strict control URL) asks a direct machine's native sheet; a
            // real Access redirect on a direct machine means it belongs to an org.
            case .reauth:
                if self.orgRoute != nil {
                    self.coordinator.onReauthSignal()
                } else if url.scheme == "yaranapp" {
                    self.directSignIn()
                } else {
                    self.showOverlay("access_on_direct")
                }
            case .closeHome: self.close("home")
            case .closeSettings: self.close("settings")
            case .external: UIApplication.shared.open(url)
            case .allow, .allowInPlace, .block, .ignore: break
            }
        }
        navigation.onRefusal = { [weak self] verdict, code in self?.showRefusal(verdict, code: code) }
        navigation.onDownloadRefused = { [weak self] in self?.toast("download_refused") }
        navigation.onLoadFailure = { [weak self] failure in
            guard let self else { return }
            switch failure {
            case .tls: self.showOverlay("tls_error")
            case .offline: self.showOverlay(self.target.routes.count > 1 ? "offline_routes" : self.orgRoute != nil ? "offline" : "direct_offline")
            }
        }
        navigation.onContentProcessTerminated = { [weak self] in
            // Behind the lock nothing loads: the resume after the unlock owes the page exactly one reload.
            guard let self, self.reloads.contentTerminated(locked: self.locked) else { return }
            self.toast("renderer_crashed")
            if self.target.kind == "org" { self.loadCurrent() } else { self.select(current: self.chosen, retry: true) }
        }
        navigation.onCommitted = { [weak self] url in self?.lastUrl = url }
    }

    // MARK: loading

    func run(_ step: LockGate.Step) {
        switch step {
        case .none: break
        case .open: open(context: .open)
        case .resume: open(context: .resume)
        }
    }

    private func open(context: RenewalContext) {
        if target.kind != "org" { return openRouted(context: context) }
        openOrg(context: context)
    }

    /// An org route's open or resume: an unreadable session says so instead of signing in by itself.
    func openOrg(context: RenewalContext) {
        if let org = orgRoute, case .some(StoredRecordError.unreadable) = readError(org.host) { return showOverlay("session_unreadable") }
        let decision = context == .open ? coordinator.onOpen() : coordinator.onResume()
        switch decision {
        // A resume re-injects only; it reloads when a renderer was lost behind the lock.
        case .load: if context == .open || reloads.owed { loadCurrent() } else { inject { _ in } }
        case .wait: break // back from Mail or an authenticator mid sign-in: that renewal reloads
        case .renewFirst:
            let owned = tenure.check()
            coordinator.renewNow { [weak self] outcome in
                guard let self, owned() else { return } // a route this window left: nothing over the new one
                if case .signedIn = outcome { return } // renewNow already re-injected and reloaded
                self.showReauthOverlay()
                self.toastSignIn(outcome)
            }
        }
        coordinator.onVisibilityChanged(true)
    }

    private func readError(_ host: String) -> Error? {
        do { _ = try services.sessions.get(host); return nil } catch { return error }
    }

    /// Re-injects the current route's own credential, then loads the page's last same-host URL.
    func loadCurrent() {
        guard orgRoute != nil else { return loadDirect() }
        // No page of a yaran too old for the app (`native_auth_ui`) is ever loaded: one probe admits one load.
        guard tenure.takeAdmission() else { return admit { [weak self] in self?.loadCurrent() } }
        let owned = tenure.check()
        inject { [weak self] injected in
            guard let self, owned() else { return }
            guard injected else { return self.coordinator.onReauthSignal() }
            self.reloads.loaded() // settled only by a navigation actually submitted
            self.tenure.passDocument(self.lastUrl)
            self.webView.load(URLRequest(url: self.lastUrl))
        }
    }

    private func inject(_ done: @escaping (Bool) -> Void) {
        guard let org = orgRoute, let session = try? services.sessions.get(org.host, orgId: org.orgId),
              let cookie = try? CookieSpec.make(kind: session.credentialKind, jwt: session.jwt, cookie: session.cookie) else {
            return done(false)
        }
        if cookie.diagnostic { services.diagnostics?.append(diagLine("cookie rung without cookie field", [("host", org.host)])) }
        let store = webView.configuration.websiteDataStore.httpCookieStore, owned = tenure.check()
        Task { @MainActor in
            guard owned() else { return }
            let visible = await CookieInjector.inject(cookie, host: org.host, into: store)
            guard owned() else { return }
            if !visible { self.services.diagnostics?.append(diagLine("cookie not visible after inject", [("host", org.host)])) }
            done(visible)
        }
    }

    // MARK: closing

    func close(_ reason: String, code: String? = nil) {
        guard !closed else { return }
        tenure.close()
        settlePrompts()
        coordinator.onVisibilityChanged(false)
        // Lifecycle and lock events must stop at close, not when the dismissal ends and deinit runs.
        // swiftlint:disable:next notification_center_detachment
        NotificationCenter.default.removeObserver(self)
        webView.stopLoading()
        services.shareInbox.remove(target.shared) // only this window's own files; a newer share stays
        let payload = ClosedPayload.make(reason: reason, code: code, routes: target.routes.map(\.host), chosen: chosen)
        dismiss(animated: true) { [onClosed] in onClosed(payload) }
    }
}
