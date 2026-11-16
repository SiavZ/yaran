/// Handoff: the G13 consent URL builder and the secret-free callback summary.
///
/// Builds `https://<consent-host>/v1/handoff?state=…&redirect=…&build=…&device=…` with a fresh
/// 32-byte base64url `state`, and turns a callback URL into what the evidence may record:
/// parameter names, whether `state` matched, and whether `jwe` / `error` were present.
///
/// - The `jwe` value never leaves this file; `CallbackSummary` has no field that could hold it.
/// - Release-shaped runs redirect to `https://<callback-host>/auth/callback`; dev-shaped runs
///   to `yaranapp-gate://auth/callback` (the spike's scheme, so it cannot collide with a real
///   `yaranapp` install).
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// GateSpikeCore/Handoff
/// ├── App/AuthSpike (inferred)
/// └── GateSpikeCoreTests/HandoffTests (inferred)
/// <module-headers:end>
import Foundation

public enum HandoffBuild: String {
    case release
    case dev
}

public struct CallbackSummary: Equatable {
    public let paramNames: [String]
    public let stateOk: Bool
    public let hasJwe: Bool
    public let hasError: Bool
    public let error: String?
    /// Scheme, host and path only.
    public let detail: String
}

public enum Handoff {
    public static let devScheme = "yaranapp-gate"
    public static let callbackPath = "/auth/callback"

    public static func randomState() -> String {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &rng) }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func redirect(build: HandoffBuild, callbackHost: String) -> String {
        switch build {
        case .release: return "https://\(callbackHost)\(callbackPath)"
        case .dev: return "\(devScheme)://auth/callback"
        }
    }

    /// nil when the consent host is not a bare host[:port].
    public static func consentURL(consentHost: String, state: String, build: HandoffBuild,
                                  callbackHost: String, device: String) -> URL? {
        let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-:")
        guard !consentHost.isEmpty, consentHost.allSatisfy(allowed.contains) else { return nil }
        var c = URLComponents()
        c.scheme = "https"
        c.host = consentHost.split(separator: ":").first.map(String.init)
        if let port = consentHost.split(separator: ":").dropFirst().first {
            guard let p = Int(port) else { return nil }
            c.port = p
        }
        c.path = "/v1/handoff"
        c.queryItems = [
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "redirect", value: redirect(build: build, callbackHost: callbackHost)),
            URLQueryItem(name: "build", value: build.rawValue),
            URLQueryItem(name: "device", value: device),
        ]
        return c.url
    }

    public static func summarize(_ url: URL?, expectedState: String?) -> CallbackSummary {
        guard let url, let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return CallbackSummary(paramNames: [], stateOk: false, hasJwe: false, hasError: false,
                                   error: nil, detail: "no callback URL")
        }
        let items = c.queryItems ?? []
        let value = { (name: String) in items.first(where: { $0.name == name })?.value }
        let error = value("error").map { String($0.prefix(64)) }
        return CallbackSummary(
            paramNames: items.map(\.name),
            stateOk: expectedState != nil && value("state") == expectedState,
            hasJwe: items.contains { $0.name == "jwe" },
            hasError: error != nil,
            error: error,
            detail: "\(c.scheme ?? "")://\(c.host ?? "")\(c.path)"
        )
    }
}
