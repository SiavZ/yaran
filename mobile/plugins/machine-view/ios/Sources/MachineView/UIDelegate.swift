/// The machine WebView's `WKUIDelegate`: new windows, permissions, nothing else.
///
/// A `window.open`/`_blank` that reaches here runs the navigation policy as a new window (same
/// host loads in place, off-host goes to the system browser) and never returns a second web
/// view. Camera, microphone and motion requests are denied: yaran's UI needs none of them.
/// File inputs use WebKit's own picker (G6 records whether that holds before iOS 18.4).
///
/// - Main actor. Not compiled on this machine (UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/UIDelegate
/// └── MachineViewCore/NavigationDelegate (inferred)
/// External: UIKit, WebKit
///
/// Used by:
/// MachineView/UIDelegate
/// └── MachineView/MachineViewController (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

@MainActor
final class UIDelegate: NSObject, WKUIDelegate {
    private let navigation: NavigationDelegate

    init(navigation: NavigationDelegate) { self.navigation = navigation }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // WebKit's popup blocker only lets a gesture-initiated window.open through.
        _ = navigation.apply(url: navigationAction.request.url, mainFrame: true, newWindow: true, gesture: true) {
            webView.load(URLRequest(url: $0))
        }
        return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
}
