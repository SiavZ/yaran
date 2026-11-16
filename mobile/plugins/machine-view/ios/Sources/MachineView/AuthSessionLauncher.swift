/// The iOS system-browser leg: `ASWebAuthenticationSession` with the build's callback.
///
/// Release builds use `.https(host: <publisher-domain>, path: "/auth/callback")`, which iOS
/// delivers only to the calling session of an app the domain's AASA vouches for; builds
/// without a publisher domain use `.customScheme("yaranapp")`. The session is never ephemeral,
/// so IdP and passkey sessions and the server's remembered-consent cookie (D24) are reused;
/// iOS still shows its own "wants to use … to sign in" alert on every start.
///
/// - Main actor; one session at a time (a new launch replaces the old one).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/AuthSessionLauncher
/// ├── MachineViewCore/CallbackUrl (inferred)
/// └── MachineViewCore/HandoffClient (inferred)
/// External: AuthenticationServices, UIKit
///
/// Used by:
/// MachineView/AuthSessionLauncher
/// └── MachineView/AppServices (inferred)
/// <module-headers:end>
import AuthenticationServices
import MachineViewCore
import UIKit

@MainActor
final class AuthSessionLauncher: NSObject, @preconcurrency HandoffLauncher, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private var launches = 0

    func launch(url: URL, mode: CallbackMode, completion: @escaping (LauncherResult) -> Void) {
        let callback: ASWebAuthenticationSession.Callback
        switch mode {
        case .https(let domain): callback = .https(host: domain, path: CallbackUrl.path)
        case .dev: callback = .customScheme("yaranapp")
        }
        session?.cancel()
        launches += 1
        let id = launches
        let authSession = ASWebAuthenticationSession(url: url, callback: callback) { [weak self] callbackURL, error in
            DispatchQueue.main.async {
                // A replaced session's late cancel must not drop the newer one, which iOS needs held while it runs.
                if self?.launches == id { self?.session = nil }
                completion(Self.result(callbackURL, error))
            }
        }
        authSession.presentationContextProvider = self
        authSession.prefersEphemeralWebBrowserSession = HandoffClient.prefersEphemeralWebBrowserSession
        session = authSession
        if !authSession.start() {
            session = nil
            completion(.noBrowser)
        }
    }

    nonisolated static func result(_ url: URL?, _ error: Error?) -> LauncherResult {
        if let url { return .redirect(url) }
        guard let authError = error as? ASWebAuthenticationSessionError else { return .cancelled }
        switch authError.code {
        case .canceledLogin: return .cancelled
        case .presentationContextNotProvided, .presentationContextInvalid: return .noBrowser
        @unknown default: return .cancelled
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first.map { UIWindow(windowScene: $0) } ?? UIWindow()
    }
}
