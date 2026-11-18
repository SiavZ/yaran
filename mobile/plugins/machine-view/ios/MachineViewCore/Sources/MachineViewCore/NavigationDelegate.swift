/// The machine WebView's `WKNavigationDelegate`: applies the navigation and refusal policies.
///
/// Every navigation (including server redirects and `targetFrame == nil` new windows) goes
/// through `NavigationPolicy` before it happens, so control URLs and Access logins never load;
/// every main-frame response goes through `RefusalPolicy` (the `Yaran-Refusal` header, 401/403
/// from Access, 530) and the download check. What the policy decides is handed to the window
/// through closures, which keeps this file free of UIKit and compiled on macOS.
///
/// - Main actor. Diagnostics carry the scheme and host of a URL, never its path or query.
/// - TLS failures are never bypassed: the default challenge handling rejects a bad certificate.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/NavigationDelegate
/// ├── MachineViewCore/NavigationPolicy (inferred)
/// ├── MachineViewCore/RefusalPolicy (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation, WebKit
///
/// Used by:
/// MachineViewCore/NavigationDelegate
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/UIDelegate (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>
#if canImport(WebKit)
import Foundation
import WebKit

public enum LoadFailure: Equatable { case tls, offline }

@MainActor
public final class NavigationDelegate: NSObject, WKNavigationDelegate {
    public let pinnedHost: String
    private let diagnostics: DiagnosticsSink?
    /// reauth, closeHome, closeSettings and external (with the URL to open).
    public var onAction: (NavigationDecision, URL) -> Void = { _, _ in }
    public var onRefusal: (RefusalVerdict, String?) -> Void = { _, _ in }
    public var onDownloadRefused: () -> Void = {}
    public var onLoadFailure: (LoadFailure) -> Void = { _ in }
    public var onContentProcessTerminated: () -> Void = {}
    /// The page's same-host URL after each committed main-frame load (process-death restore).
    public var onCommitted: (URL) -> Void = { _ in }
    /// Admits a main-frame document navigation the policy allows (a native load, a reload, a link,
    /// a form, a new-window target loaded in place): call the decision exactly once, true to load.
    /// Unset: allowed as before.
    public var admitDocument: ((URL, @escaping @MainActor (Bool) -> Void) -> Void)?

    public init(pinnedHost: String, diagnostics: DiagnosticsSink?) {
        self.pinnedHost = pinnedHost
        self.diagnostics = diagnostics
    }

    /// Runs the policy; returns true when WebKit should go ahead with this exact navigation.
    public func apply(url: URL?, mainFrame: Bool, newWindow: Bool, gesture: Bool, load: (URL) -> Void) -> Bool {
        let raw = url?.absoluteString ?? ""
        let verdict = NavigationPolicy.decide(pinnedHost: pinnedHost, url: raw, mainFrame: mainFrame, newWindow: newWindow,
                                              gesture: gesture)
        if verdict.diagnostic {
            diagnostics?.append(diagLine("navigation \(verdict.decision.rawValue)",
                                         [("scheme", url?.scheme ?? "-"), ("host", url?.host ?? "-")]))
        }
        switch verdict.decision {
        case .allow:
            return true
        case .allowInPlace:
            if let url { load(url) }
            return false
        case .reauth, .closeHome, .closeSettings, .external:
            if let url { onAction(verdict.decision, url) }
            return false
        case .block, .ignore:
            return false
        }
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        let newWindow = navigationAction.targetFrame == nil
        // A new window only opens on a user gesture (javaScriptCanOpenWindowsAutomatically is off).
        let gesture = newWindow || navigationAction.navigationType == .linkActivated
        let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
        let proceed = apply(url: navigationAction.request.url, mainFrame: mainFrame,
                       newWindow: newWindow, gesture: gesture) { webView.load(URLRequest(url: $0)) }
        guard proceed, mainFrame, !newWindow, let url = navigationAction.request.url, let admit = admitDocument,
              !Self.isSameDocument(url, from: webView.url, reload: navigationAction.navigationType == .reload,
                                   method: navigationAction.request.httpMethod) else {
            return decisionHandler(proceed ? .allow : .cancel)
        }
        admit(url) { decisionHandler($0 ? .allow : .cancel) }
    }

    /// A move within the page already loaded (a fragment change by a link or `location.hash`):
    /// no document is fetched, so nothing to admit. A reload, a form post or any other URL is a document.
    public static func isSameDocument(_ url: URL, from current: URL?, reload: Bool, method: String?) -> Bool {
        guard !reload, (method ?? "GET").uppercased() == "GET", url.fragment != nil, let current else { return false }
        return url.absoluteString.components(separatedBy: "#")[0] == current.absoluteString.components(separatedBy: "#")[0]
    }

    public func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                        decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let http = navigationResponse.response as? HTTPURLResponse
        if navigationResponse.isForMainFrame, let http {
            let code = http.value(forHTTPHeaderField: RefusalPolicy.header)
            let verdict = RefusalPolicy.decide(status: http.statusCode, refusal: code)
            if verdict.decision != .none {
                if verdict.diagnostic { diagnostics?.append(diagLine("refusal unknown", [("status", String(http.statusCode))])) }
                decisionHandler(.cancel)
                onRefusal(verdict, code)
                return
            }
        }
        let attachment = http?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().hasPrefix("attachment") == true
        if attachment || !navigationResponse.canShowMIMEType {
            decisionHandler(.cancel)
            onDownloadRefused()
            return
        }
        decisionHandler(.allow)
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        if let url = webView.url, url.host?.lowercased() == pinnedHost.lowercased(), url.scheme == "https" { onCommitted(url) }
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        diagnostics?.append(diagLine("render process gone"))
        onContentProcessTerminated()
    }

    func failed(_ error: Error) {
        guard let failure = Self.classify(error as NSError) else { return }
        diagnostics?.append(diagLine("load failed", [("kind", failure == .tls ? "tls" : "offline"),
                                                     ("code", String((error as NSError).code))]))
        onLoadFailure(failure)
    }

    /// nil for errors that are ours (a cancelled navigation, a policy change).
    static func classify(_ error: NSError) -> LoadFailure? {
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return nil }
        if error.domain == "WebKitErrorDomain" { return nil }
        let tls: Set<Int> = [NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateUntrusted,
                             NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateNotYetValid,
                             NSURLErrorClientCertificateRejected, NSURLErrorClientCertificateRequired]
        return error.domain == NSURLErrorDomain && tls.contains(error.code) ? .tls : .offline
    }
}
#endif
