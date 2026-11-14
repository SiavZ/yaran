/// AuthSpike: the G13 iOS probe for ASWebAuthenticationSession with `.https` and custom-scheme callbacks.
///
/// Builds the consent URL from a pasted consent host (GateSpikeCore), then starts an
/// `ASWebAuthenticationSession` with `Callback.https(host:path:)` for the release-shaped run or
/// `Callback.customScheme("yaranapp-gate")` for the dev-shaped run, with the
/// `prefersEphemeralWebBrowserSession` toggle. The completion is reported as parameter names,
/// the `state` check and `jwe`/`error` presence, plus `canceledLogin` and presentation errors.
/// A debug start with no presentation context provider records that error for the evidence.
///
/// - Never logs or returns the `jwe` value or the full callback URL.
/// - The callback host comes from Info.plist `GateCallbackHost` (build setting GATE_CALLBACK_HOST).
///
/// <module-headers:begin>
/// Uses:
/// App/AuthSpike
/// ├── App/MachineViewSpike (inferred)   (gateLog)
/// └── GateSpikeCore/Handoff (inferred)
/// External: AuthenticationServices, Capacitor, UIKit
///
/// Used by:
/// App/AuthSpike
/// └── App/GateSpikeViewController (inferred)
/// <module-headers:end>
import AuthenticationServices
import Capacitor
import GateSpikeCore
import UIKit

@objc(AuthSpike)
public class AuthSpike: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AuthSpike"
    public let jsName = "AuthSpike"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
    ]

    private var session: ASWebAuthenticationSession?
    private var pendingState: String?

    private var callbackHost: String {
        Bundle.main.object(forInfoDictionaryKey: "GateCallbackHost") as? String ?? "gate-cb.example.invalid"
    }

    @objc func info(_ call: CAPPluginCall) {
        call.resolve([
            "callbackHost": callbackHost,
            "devScheme": Handoff.devScheme,
            "systemVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        let build: HandoffBuild = call.getString("mode") == "dev" ? .dev : .release
        let state = Handoff.randomState()
        guard let url = Handoff.consentURL(consentHost: call.getString("consentHost") ?? "", state: state,
                                           build: build, callbackHost: callbackHost,
                                           device: call.getString("deviceLabel") ?? "gate-device")
        else {
            call.reject("consentHost must be a bare host name such as gate-cp.<staging-zone>")
            return
        }
        pendingState = state
        let ephemeral = call.getBool("ephemeral") ?? false
        let nilContext = call.getBool("nilPresentationContext") ?? false
        let callback: ASWebAuthenticationSession.Callback
        switch build {
        case .release: callback = .https(host: callbackHost, path: Handoff.callbackPath)
        case .dev: callback = .customScheme(Handoff.devScheme)
        }
        DispatchQueue.main.async {
            let s = ASWebAuthenticationSession(url: url, callback: callback) { [weak self] url, error in
                self?.finish(url: url, error: error, build: build)
            }
            s.prefersEphemeralWebBrowserSession = ephemeral
            if !nilContext { s.presentationContextProvider = self }
            self.session = s
            let started = s.start()
            let via = "ASWebAuthenticationSession \(build.rawValue) ephemeral=\(ephemeral) nilContext=\(nilContext) started=\(started)"
            gateLog.info("authStart \(via, privacy: .public)")
            call.resolve(["via": via, "consentUrlHost": url.host ?? ""])
        }
    }

    private func finish(url: URL?, error: Error?, build: HandoffBuild) {
        let s = Handoff.summarize(url, expectedState: pendingState)
        var data: [String: Any] = [
            "path": "ASWebAuthenticationSession \(build.rawValue)",
            "paramNames": s.paramNames,
            "stateOk": s.stateOk,
            "hasJwe": s.hasJwe,
            "hasError": s.hasError,
            "detail": s.detail,
        ]
        if let e = s.error { data["error"] = e }
        if let error { data["detail"] = describe(error) }
        gateLog.info("authResult \(String(describing: data), privacy: .public)")
        notifyListeners("authResult", data: data, retainUntilConsumed: true)
        session = nil
    }

    private func describe(_ error: Error) -> String {
        guard let e = error as? ASWebAuthenticationSessionError else { return "\(error)" }
        switch e.code {
        case .canceledLogin: return "canceledLogin"
        case .presentationContextNotProvided: return "presentationContextNotProvided"
        case .presentationContextInvalid: return "presentationContextInvalid"
        @unknown default: return "ASWebAuthenticationSessionError code \(e.code.rawValue)"
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
