/// MachineViewSpike: the G1/G3/G6/G12 iOS probe for a bridge-free machine WKWebView.
///
/// The plugin takes the pasted Access JWT, turns it into a host-only `CF_Authorization`
/// HTTPCookie (GateSpikeCore), and presents `MachineViewController` full screen. That
/// controller owns its OWN `WKWebView` with a fresh configuration: no script message handler,
/// no Capacitor bridge. It writes the cookie with `WKHTTPCookieStore.setCookie` and loads the
/// machine URL only in the completion handler. `keyboardGuide` pins the web view's bottom to
/// `keyboardLayoutGuide` (the G6 iOS fallback) so both behaviours can be compared.
///
/// - Trust boundary: the JWT comes only from the shell's paste field, is validated by
///   GateSpikeCore, never logged and never returned to JavaScript.
/// - All UIKit and WebKit work runs on the main thread.
///
/// <module-headers:begin>
/// Uses:
/// App/MachineViewSpike
/// └── GateSpikeCore/AccessCookie (inferred)
/// External: Capacitor, UIKit, WebKit, os
///
/// Used by:
/// App/MachineViewSpike
/// ├── App/AuthSpike (inferred)                (gateLog)
/// ├── App/GateSpikeViewController (inferred)
/// └── App/PushSpike (inferred)                (gateLog)
/// <module-headers:end>
import Capacitor
import GateSpikeCore
import os
import UIKit
import WebKit

let gateLog = Logger(subsystem: "io.github.siavz.yaran.gatespike", category: "GateSpike")

@objc(MachineViewSpike)
public class MachineViewSpike: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MachineViewSpike"
    public let jsName = "MachineViewSpike"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise)
    ]

    @objc func open(_ call: CAPPluginCall) {
        guard let target = URL(string: call.getString("url") ?? ""), target.scheme == "https",
              let host = target.host, !host.isEmpty, let origin = URL(string: "https://\(host)/")
        else {
            call.reject("url must be https://<machine-host>/")
            return
        }
        let cookie: HTTPCookie
        do {
            cookie = try AccessCookie.cookie(jwt: call.getString("jwt") ?? "",
                                             sameSite: call.getString("sameSite") ?? "Lax", url: origin)
        } catch {
            call.reject("cookie refused: \(error)")
            return
        }
        let keyboardGuide = call.getBool("keyboardGuide") ?? false
        let expires = cookie.expiresDate.map { AccessCookie.rfc1123(Int64($0.timeIntervalSince1970)) } ?? "session"
        DispatchQueue.main.async {
            let vc = MachineViewController(target: target, cookie: cookie, keyboardGuide: keyboardGuide)
            vc.modalPresentationStyle = .fullScreen
            self.bridge?.presentVC(vc, animated: true, completion: nil)
            call.resolve(["cookieUrl": origin.absoluteString, "expires": expires])
        }
    }
}

final class MachineViewController: UIViewController, WKNavigationDelegate {
    private let target: URL
    private let cookie: HTTPCookie
    private let keyboardGuide: Bool
    private var webView: WKWebView?

    init(target: URL, cookie: HTTPCookie, keyboardGuide: Bool) {
        self.target = target
        self.cookie = cookie
        self.keyboardGuide = keyboardGuide
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        // A fresh configuration: its userContentController has no script message handlers.
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: config)
        #if DEBUG
        web.isInspectable = true
        #endif
        web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        // Edge to edge, so the page sees real env(safe-area-inset-*) values (G6).
        let bottom = keyboardGuide ? view.keyboardLayoutGuide.topAnchor : view.bottomAnchor
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.topAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: bottom),
        ])
        addCloseButton()
        webView = web
        gateLog.info("machine-view keyboardGuide=\(self.keyboardGuide, privacy: .public)")
        config.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            guard let self, let web = self.webView else { return }
            gateLog.info("setCookie done host=\(self.target.host ?? "", privacy: .public)")
            // G1 step 2: load only once the cookie store has acknowledged the write.
            web.load(URLRequest(url: self.target))
        }
    }

    private func addCloseButton() {
        let close = UIButton(configuration: .filled(), primaryAction: UIAction(title: "Close") { [weak self] _ in
            self?.dismiss(animated: true)
        })
        close.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(close)
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            close.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -8),
            close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let r = navigationResponse.response as? HTTPURLResponse {
            // Host and path only: query strings on Access redirects are not evidence we need.
            gateLog.info("mainFrame HTTP \(r.statusCode) \(r.url?.host ?? "", privacy: .public)\(r.url?.path ?? "", privacy: .public)")
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        gateLog.info("pageFinished \(webView.url?.host ?? "", privacy: .public)\(webView.url?.path ?? "", privacy: .public)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        gateLog.error("navigation failed: \(error.localizedDescription, privacy: .public)")
    }
}
