/// The machine window's direct, routed and share half (G1, G2, G5); the twin of Android's
/// `RouteDriver` and `ShareChooser`.
///
/// At open the user's routes are probed in order, each with its own credential only; at
/// resume after the app was away 30 s or more and from the offline overlay the current route
/// is probed first and kept when it answers, so a healthy page is never moved. A chosen route
/// that differs from the current one gets a fresh WebView (its own per-host data store) before
/// anything loads. A direct route injects only its `yaran_session_<port>` cookie, after the
/// native password sheet when the machine asks for one. A lone direct route answering with
/// another instance closes `instance_changed`; a routed window no route answers at open
/// closes `no_route`; anything else is an overlay. Shared files are offered to the page's own
/// chooser after a native confirm, on iOS 18.4 and later only.
///
/// - Main actor. Not compiled into an iOS build on this machine (UIKit); type-checked against
///   Mac Catalyst UIKit by `ios/typecheck-catalyst.sh`.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewController+Direct
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/PendingChooser (inferred)
/// ├── MachineViewCore/RenewalPolicy (inferred)
/// ├── MachineViewCore/RouteFragment (inferred)
/// ├── MachineViewCore/RouteTenure (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: UIKit, WebKit
///
/// Used by: entry point (a Swift extension of MachineViewController, compiled into the MachineView module (no import names it))
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

extension MachineViewController {
    private static let parkedSeconds: TimeInterval = 30

    func openRouted(context: RenewalContext) {
        let away = backgroundedAt.map { Date().timeIntervalSince($0) } ?? 0
        backgroundedAt = nil
        switch context {
        case .open: select(current: nil, retry: false)
        // Away long enough for the page's sockets to park: probe again, the current route first; a renderer lost
        // under the lock still gets its one reload, on whichever route answers.
        case .resume where away >= Self.parkedSeconds: select(current: chosen, retry: reloads.owed)
        default:
            if orgRoute != nil { openOrg(context: context) } else if reloads.owed { loadRoute(nil) } else { reinjectDirect() }
        }
    }

    /// Probes the routes ([current] nil at open) and acts on the choice.
    func select(current: Int?, retry: Bool) {
        let routes = target.routes, instance = target.instance, services = self.services
        let owned = tenure.check() // a selection a switch or close overtook acts on nothing
        Task { @MainActor [weak self] in
            var statuses = [DirectStatus?](repeating: nil, count: routes.count)
            var probes = [Probe](repeating: .unreachable, count: routes.count)
            for (index, route) in routes.enumerated() { (probes[index], statuses[index]) = await Self.probe(route, instance, services) }
            // shortcut: every route is probed before choosing (at most four, bounded timeouts); probe lazily if that delay shows.
            let selection = RouteSelector.select(count: routes.count, current: current) { probes[$0] }
            guard owned() else { return }
            self?.onSelected(selection, statuses, current: current, retry: retry)
        }
    }

    private static func probe(_ route: MachineRoute, _ instance: String?, _ services: AppServices) async -> (Probe, DirectStatus?) {
        let timeout = DirectAuth.probeTimeout(route.host)
        switch route {
        case .direct(let host):
            let stored = try? services.directSessions.get(host)
            let status = await services.directAuth.status(host: host, stored: stored ?? nil, timeout: timeout, expected: instance)
            return (RouteSelector.probe(of: status, instance: instance), status)
        case let .org(orgId, _, host):
            let status = try? await services.directAuth.orgRouteStatus(orgId: orgId, host: host, sessions: services.sessions,
                                                                       now: AppServices.now(), timeout: timeout)
            guard let status = status ?? nil else { return (.signInFirst, nil) }
            return (RouteSelector.probe(of: status, instance: instance), status)
        }
    }

    private func onSelected(_ selection: Selection, _ statuses: [DirectStatus?], current: Int?, retry: Bool) {
        switch selection {
        case .kept(let index):
            // Admitted only for a load that follows; a page kept as it is holds no admission.
            if retry { admitFrom(statuses[index]) } else { tenure.revokeAdmission() }
            observe(statuses[index])
            if retry {
                loadRoute(statuses[index])
            } else if orgRoute == nil {
                // The session read (and its stale-instance cleanup) decides any sheet, as on every path.
                settleDirect(statuses[index]) { [weak self] in self?.reinjectDirect() }
            } else {
                openOrg(context: .resume)
            }
        case .chosen(let index):
            switchRoute(index)
            admitFrom(statuses[index])
            observe(statuses[index])
            loadRoute(statuses[index])
        case .signInFirst(let index):
            switchRoute(index)
            loadRoute(nil)
        case .noRoute:
            if let current, statuses[current] == .upgradeRequired {
                close("error", code: "upgrade_required") // never kept under a page its machine can no longer vouch for
            } else if let current, target.kind == "direct", case .yaran? = statuses[current] {
                close("error", code: "instance_changed") // a lone machine that answered as another yaran is not offline
            } else if target.kind == "routes", current == nil {
                close("error", code: statuses.contains(.upgradeRequired) ? "upgrade_required" : "no_route")
            } else if target.kind == "routes", retry {
                showOverlay("offline_routes")
                toast("no_other_route")
            } else if current != nil, !retry {
                services.diagnostics?.append(diagLine("no route answered at resume; the page stays"))
            } else {
                directFailure(statuses.first ?? nil)
            }
        }
    }

    private func admitFrom(_ status: DirectStatus?) {
        if case .yaran = status { tenure.admit() }
    }

    /// A fresh probe of the current route, for loading a document of it here. Its yaran must say
    /// its page signs in natively (`native_auth_ui`; compatibility, never authorization) and still
    /// be the machine this window's context is for: a probe mismatch, or an instance other than
    /// the one observed at the last selection, is a new selection, never an admission carrying the
    /// old instance's session along. `done` is always called, `stale` once the route or window moved on.
    private func probeDocument(_ done: @escaping (DocumentVerdict, DirectStatus?) -> Void) {
        let owned = tenure.check(), route = target.routes[chosen], instance = target.instance, seen = observed
        let services = self.services
        Task { @MainActor in
            let (probe, status) = await Self.probe(route, instance, services)
            done(owned() ? DocumentVerdict.of(probe: probe, status: status, seen: seen) : .stale, status)
        }
    }

    private func act(_ verdict: DocumentVerdict, _ status: DirectStatus?, then: () -> Void) {
        switch verdict {
        case .admit:
            tenure.admit()
            then()
        case .reselect: select(current: chosen, retry: true)
        case .signIn: coordinator.onReauthSignal()
        case .refuse:
            if status == .upgradeRequired {
                close("error", code: "upgrade_required")
            } else if orgRoute != nil {
                showOverlay("offline")
            } else {
                directFailure(status)
            }
        case .stale: break
        }
    }

    /// A load with no admission from the selection that just ran probes the current route first.
    func admit(_ then: @escaping () -> Void) {
        probeDocument { [weak self] verdict, status in self?.act(verdict, status, then: then) }
    }

    /// `NavigationDelegate.admitDocument` for this window (weak: a pending decision never keeps it alive).
    var admissionHook: (URL, @escaping @MainActor (Bool) -> Void) -> Void {
        { [weak self] url, decide in
            guard let self else { return decide(false) }
            self.admitDocument(url, decide)
        }
    }

    /// A main-frame document navigation WebKit is about to start (the native load, or one the page
    /// started: a reload, a link, a form, a new-window target loaded in place): the native load's
    /// pass, or a fresh probe; `decide` is called exactly once.
    func admitDocument(_ url: URL, _ decide: @escaping @MainActor (Bool) -> Void) {
        // NavigationPolicy already approved local documents; only network documents need a machine probe.
        if !["http", "https"].contains(url.scheme?.lowercased() ?? "") { return decide(true) }
        guard DocumentVerdict.isRouteOrigin(url, host: host) else { return decide(false) } // nothing lent to another origin
        if tenure.takeDocumentPass(url) { return decide(true) }
        probeDocument { [weak self] verdict, status in
            decide(verdict == .admit)
            if verdict != .admit { self?.act(verdict, status) {} }
        }
    }

    private func observe(_ status: DirectStatus?) {
        if case let .yaran(instance, _, _, _, _) = status { observed = instance }
    }

    private func directFailure(_ status: DirectStatus?) {
        switch status {
        case .yaran: close("error", code: "instance_changed")
        case .accessRequired: showOverlay("access_on_direct")
        case .redirected: showOverlay("redirected")
        case .tlsError: showOverlay("tls_error")
        case .offline, nil: showOverlay("direct_offline")
        case .notYaran, .vaultLocked, .refused: showOverlay("not_yaran")
        case .upgradeRequired: close("error", code: "upgrade_required")
        }
    }

    /// A new origin gets a new WebView and data store: nothing of the old page survives.
    private func switchRoute(_ index: Int) {
        guard index != chosen else { return }
        // A new origin is a new tenure: every probe, sheet, sign-in, cookie change, load and renewal
        // the old route started is inert from here, a switch back to it included.
        tenure.switched()
        coordinator.routeChanged()
        settlePrompts()
        services.diagnostics?.append(diagLine("route switch", [("host", target.routes[index].host)]))
        let fragment = lastUrl.fragment.map { "#" + $0 }.flatMap { RouteFragment.isValid($0) ? $0 : nil } ?? ""
        dropWebView()
        hideOverlay()
        hideBanner()
        chosen = index
        observed = nil
        fresh = nil
        lastUrl = URL(string: "https://\(host)/\(fragment)")!
        makeWebView()
    }

    private func loadRoute(_ status: DirectStatus?) {
        if orgRoute != nil { return openOrg(context: .open) }
        settleDirect(status) { [weak self] in self?.loadDirect() }
    }

    /// Every direct sheet-or-proceed decision (`DirectLifecycle.settle`): the session is read, and a
    /// stale instance's record and cookies are gone, before the password is asked or `proceed` runs.
    private func settleDirect(_ status: DirectStatus?, proceed: @escaping () -> Void) {
        let owned = tenure.check(), host = self.host, seen = observed, mine = fresh, store = services.directSessions
        let jar = webView.configuration.websiteDataStore.httpCookieStore
        Task { @MainActor [weak self] in
            let settle: DirectLifecycle.Settle?
            do {
                settle = try await DirectLifecycle.settle(host: host, status: status, observed: seen, fresh: mine, store: store, jar: jar, owned: owned)
            } catch {
                if owned() { self?.showOverlay("session_unreadable") }
                return
            }
            guard let self, let settle else { return }
            guard settle == .signIn else { return proceed() }
            self.tenure.revokeAdmission() // the sheet comes first; its success selects, and admits, again
            self.directSignIn()
        }
    }

    func directSignIn() {
        // One attempt (preflight, sheet, POST) per window and route; a route change or close ends it.
        guard let attempt = prompts.reserveSignIn() else { return }
        let owned = tenure.check()
        DirectFlow.signIn(from: self, host: host, owned: owned, onSheet: { [weak self] in self?.prompts.sheet = $0 }, done: { [weak self] outcome in
            self?.prompts.releaseSignIn(attempt)
            guard let self, owned() else { return }
            switch outcome {
            case .upgradeRequired: self.close("error", code: "upgrade_required")
            case .signedIn, .notRequired: // probe again, so the new session is checked against the machine
                if case let .signedIn(_, _, signInId) = outcome { self.fresh = signInId }
                self.hideOverlay()
                self.select(current: self.chosen, retry: true)
            default:
                var values = self.vars
                if case let .serverRefused(_, code, _) = outcome { values["code"] = code }
                if case let .refused(reason) = outcome { values["code"] = reason }
                let detail = [Messages.direct[outcome.kind].map { Messages.fill($0, values) }, outcome.serverMessage].compactMap { $0 }
                self.showOverlay("reauth", detail: detail.joined(separator: "\n\n"))
            }
        })
    }

    /// Injects only this host's own session, issued by the instance just observed, then loads. A
    /// record from another instance is deleted with every cookie of the host first.
    func loadDirect() {
        guard !closed else { return }
        guard tenure.takeAdmission() else { return admit { [weak self] in self?.loadDirect() } }
        let url = lastUrl, host = self.host
        let current: (session: DirectSession?, dropped: Bool)
        do { current = try services.directSessions.current(host, instance: observed, fresh: fresh) } catch {
            return showOverlay("session_unreadable")
        }
        let store = webView.configuration.websiteDataStore.httpCookieStore, owned = tenure.check()
        Task { @MainActor [weak self] in
            let still = await DirectLifecycle.inject(host: host, dropped: current.dropped, cookie: current.session.flatMap(DirectFlow.cookie),
                                                     into: store, owned: owned)
            guard still, let self else { return }
            self.reloads.loaded() // settled only by a navigation actually submitted
            self.tenure.passDocument(url)
            self.webView.load(URLRequest(url: url))
        }
    }

    func reinjectDirect() {
        let host = self.host
        guard !closed, let current = try? services.directSessions.current(host, instance: observed, fresh: fresh) else { return }
        let store = webView.configuration.websiteDataStore.httpCookieStore, owned = tenure.check()
        Task { @MainActor in
            _ = await DirectLifecycle.inject(host: host, dropped: current.dropped, cookie: current.session.flatMap(DirectFlow.cookie),
                                             into: store, owned: owned)
        }
    }

    // MARK: shared files

    /// Asks before the page's chooser gets the held files; Choose other files opens the Files picker.
    /// The page that asked owns the answer, and only while it is on screen: the files are the ones
    /// held when the confirm opened (`PendingChooser`), a route switch or close answers it with
    /// nothing, once, and keeps the files for the next page.
    func offerShare(multiple: Bool, _ done: @escaping ([URL]?) -> Void) {
        guard !shared.isEmpty else { return done(nil) }
        settlePrompts()
        let held = multiple ? shared : Array(shared.prefix(1))
        let pending = PendingChooser(held: held, owned: tenure.check(), answer: done)
        prompts.chooser = pending
        let key = multiple || shared.count == 1 ? "share_confirm" : "share_confirm_single"
        let alert = UIAlertController(title: nil, message: Messages.fill(Messages.overlay[key]?.message ?? key, ["count": String(shared.count)]),
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Attach shared files", style: .default) { [weak self] _ in
            guard pending.settle(pending.held), let self else { return }
            self.shared = []
            self.showShareBanner()
            self.applyUiDelegate() // WebKit's own picker again for the next file input
        })
        alert.addAction(UIAlertAction(title: "Choose other files", style: .default) { [weak self] _ in self?.pickFiles(multiple, pending) })
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in pending.cancel() })
        present(alert, animated: true)
    }

    /// The route or page that asked is going: its chooser and its password sheet get nothing, once,
    /// and go; a sheet another route or the app shows is not touched.
    func settlePrompts() {
        guard prompts.settleAll() else { return }
        if presentedViewController is UIAlertController || presentedViewController is UIDocumentPickerViewController {
            dismiss(animated: false)
        }
    }

    private func pickFiles(_ multiple: Bool, _ pending: PendingChooser) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = multiple
        let delegate = PickerDelegate { _ = pending.settle($0) }
        picker.delegate = delegate
        objc_setAssociatedObject(picker, &PickerDelegate.key, delegate, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        present(picker, animated: true)
    }

    func discardShare() {
        services.shareInbox.remove(shared) // only this window's files; a newer share stays held
        shared = []
        showShareBanner()
        applyUiDelegate()
    }
}

/// Answers the page's chooser exactly once from the Files picker.
private final class PickerDelegate: NSObject, UIDocumentPickerDelegate {
    nonisolated(unsafe) static var key = 0
    private var done: (([URL]?) -> Void)?

    init(_ done: @escaping ([URL]?) -> Void) { self.done = done }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finish(urls) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }

    private func finish(_ urls: [URL]?) {
        done?(urls)
        done = nil
    }
}

// The protocol is MachineViewCore's own; WebKit cannot introduce it.
extension WKHTTPCookieStore: @retroactive DirectCookieJar {}
