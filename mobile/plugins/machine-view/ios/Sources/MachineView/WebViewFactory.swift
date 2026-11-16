/// Builds the machine WKWebView exactly as the Phase 15 WebView configuration table says.
///
/// No bridge at all (a fresh `WKUserContentController` with no message handlers and no user
/// scripts), the machine's own persistent data store, the UA token appended to the system
/// application name, no automatic window opening, no link previews, swipe navigation on,
/// content insets left to the page (`.never`) so `env(safe-area-inset-*)` and the keyboard
/// behave as in Safari, and inspection only in Debug or the E2E configuration (hook H4).
///
/// - Main actor. Not compiled on this machine (UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/WebViewFactory
/// └── MachineViewCore/DataStores (inferred)
/// External: UIKit, WebKit
///
/// Used by:
/// MachineView/WebViewFactory
/// └── MachineView/MachineViewController (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit
import WebKit

@MainActor
enum WebViewFactory {
    static func make(host: String, uaToken: String) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController = WKUserContentController()
        config.websiteDataStore = DataStores.store(host: host)
        config.applicationNameForUserAgent = [config.applicationNameForUserAgent, uaToken].compactMap { $0 }.joined(separator: " ")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.preferences.isFraudulentWebsiteWarningEnabled = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.limitsNavigationsToAppBoundDomains = false
        config.dataDetectorTypes = []
        let web = WKWebView(frame: .zero, configuration: config)
        web.allowsLinkPreview = false
        web.allowsBackForwardNavigationGestures = true
        web.scrollView.contentInsetAdjustmentBehavior = .never
        #if DEBUG || E2E
        web.isInspectable = true
        #else
        web.isInspectable = false
        #endif
        return web
    }
}
