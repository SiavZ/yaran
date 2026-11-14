/// The machine window's navigation decisions (Phase 15 Design, Navigation policy table).
///
/// One pure function over the house URL split, pinned by `fixtures/navigation-cases.json`
/// with its Kotlin twin: the pinned host loads in place, Access redirects become the reauth
/// overlay (an IdP is never rendered in the WebView), control URLs become native actions,
/// off-host links go to the system browser only on a user gesture, and everything else is
/// blocked with a diagnostics entry.
///
/// - Pure. `pinnedHost` is compared case-folded; port 443 is the default port.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/NavigationPolicy
/// ├── MachineViewCore/ControlUrl (inferred)
/// └── MachineViewCore/UrlParts (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/NavigationPolicy
/// ├── MachineViewCore/NavigationDelegate (inferred)
/// ├── MachineViewCoreTests/PolicyTests (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>
import Foundation

public enum NavigationDecision: String, Equatable {
    case allow
    case allowInPlace = "allow_in_place"
    case reauth
    case closeHome = "close_home"
    case closeSettings = "close_settings"
    case external
    case block
    case ignore
}

public struct NavigationVerdict: Equatable {
    public let decision: NavigationDecision
    /// The decision writes one diagnostics line (always for block and ignore).
    public var diagnostic: Bool { decision == .block || decision == .ignore }
}

public enum NavigationPolicy {
    static let accessSuffix = ".cloudflareaccess.com"
    static let accessLoginPath = "/cdn-cgi/access/login"

    public static func decide(pinnedHost: String, url: String, mainFrame: Bool, newWindow: Bool,
                              gesture: Bool) -> NavigationVerdict {
        NavigationVerdict(decision: decision(pinnedHost.lowercased(), url, mainFrame, newWindow, gesture))
    }

    private static func decision(_ pinned: String, _ url: String, _ mainFrame: Bool, _ newWindow: Bool,
                                 _ gesture: Bool) -> NavigationDecision {
        guard let p = UrlParts.parse(url) else { return .block }
        let offHost: NavigationDecision = gesture ? .external : .block
        if !mainFrame {
            if isAboutBlank(p) || (p.scheme == "https" && isPinned(p, pinned)) { return .allow }
            return .block
        }
        switch p.scheme {
        case "about":
            return isAboutBlank(p) && !newWindow ? .allow : .block
        case "yaranapp":
            switch ControlUrl.decision(url, loadedHost: pinned) {
            case .reauth: return .reauth
            case .home: return .closeHome
            case .settings: return .closeSettings
            case .ignore: return .ignore
            }
        case "https":
            guard let (host, port) = p.hostAndPort else { return .block }
            if host == pinned && (port == nil || port == 443) {
                if p.path.hasPrefix(accessLoginPath) { return .reauth }
                return newWindow ? .allowInPlace : .allow
            }
            if host.count > accessSuffix.count && host.hasSuffix(accessSuffix) { return .reauth }
            return offHost
        case "http":
            guard let (host, _) = p.hostAndPort else { return .block }
            return host == pinned ? .block : offHost
        case "mailto", "tel":
            return offHost
        case "blob":
            guard !newWindow, let inner = UrlParts.parse(p.rest), inner.scheme == "https", isPinned(inner, pinned)
            else { return .block }
            return .allow
        default:
            return .block
        }
    }

    private static func isAboutBlank(_ p: UrlParts) -> Bool {
        p.scheme == "about" && p.authority == nil && p.query == nil && p.fragment == nil
            && (p.path == "blank" || p.path == "srcdoc")
    }

    private static func isPinned(_ p: UrlParts, _ pinned: String) -> Bool {
        guard let (host, port) = p.hostAndPort else { return false }
        return host == pinned && (port == nil || port == 443)
    }
}
