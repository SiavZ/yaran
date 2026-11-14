/// The sealed-handoff orchestrator (Phase 15 steps 1-8), one sign-in at a time.
///
/// Mints the ephemeral recipient key and the state, signs the request with the org's device
/// key (D24), writes a key-free marker so a reply after process death is explained rather
/// than completed, launches the system browser through an injected `HandoffLauncher`, checks
/// the callback (`CallbackUrl`), opens the envelope (`SealedEnvelope`) and stores the session.
/// Every path ends in one `SignInOutcome`.
///
/// - The recipient key and pending state live in memory only; a new sign-in replaces them.
/// - The pending entry is single use: the first callback consumes it, a replay is a mismatch.
/// - Call from one thread (the main thread in the app).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/HandoffClient
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/CookieSpec (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffSignature (inferred)
/// ├── MachineViewCore/HandoffUrl (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// └── MachineViewCore/SessionStore (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// MachineViewCore/HandoffClient
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/AuthSessionLauncher (inferred)
/// ├── MachineView/SessionPlugin (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/HandoffClientTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation

public enum LauncherResult: Equatable {
    case redirect(URL)
    case cancelled
    case verificationFailed
    case noBrowser
}

public protocol HandoffLauncher: AnyObject {
    func launch(url: URL, mode: CallbackMode, completion: @escaping (LauncherResult) -> Void)
}

public enum SignInRequest: Equatable {
    case controlPlane
    case machine(host: String)
}

public final class HandoffClient {
    public static let markerNamespace = "handoff"
    /// Never ephemeral: IdP and passkey sessions are reused, and the server's remembered-consent
    /// cookie (D24) must survive between sign-ins (02 UNVERIFIED-5 depends on it).
    public static let prefersEphemeralWebBrowserSession = false

    struct Pending {
        let orgId: String, state: String, host: String, kind: String, createdAt: Int64
        let key: P256.KeyAgreement.PrivateKey
        let completion: (SignInOutcome) -> Void
    }

    struct Marker: Codable {
        let state: String, host: String, target: String
        let createdAt: Int64
        enum CodingKeys: String, CodingKey { case state, host, target, createdAt = "created_at" }
    }

    private let vault: SecretVault
    private let deviceKeys: DeviceKeyStore
    private let sessions: SessionStore
    private let orgs: OrgDirectory
    private let launcher: HandoffLauncher
    private let mode: CallbackMode
    private let deviceLabel: String
    private let clock: () -> Int64
    private let diagnostics: DiagnosticsSink?
    private let rung: CredentialKind
    private let fragment: Bool
    private var pending: Pending?

    public init(vault: SecretVault, deviceKeys: DeviceKeyStore, sessions: SessionStore, orgs: OrgDirectory,
                launcher: HandoffLauncher, mode: CallbackMode, deviceLabel: String, clock: @escaping () -> Int64,
                diagnostics: DiagnosticsSink?, rung: CredentialKind = Fallbacks.credentialRung,
                fragment: Bool = Fallbacks.handoffModeFragment) {
        (self.vault, self.deviceKeys, self.sessions, self.orgs, self.launcher) = (vault, deviceKeys, sessions, orgs, launcher)
        (self.mode, self.deviceLabel, self.clock, self.diagnostics, self.rung, self.fragment) =
            (mode, deviceLabel, clock, diagnostics, rung, fragment)
    }

    public func signIn(orgId: String, request: SignInRequest, completion: @escaping (SignInOutcome) -> Void) {
        let target: HandoffTarget
        let host: String
        switch request {
        case .controlPlane:
            guard let orgUrl = orgs.orgUrl(orgId), Pattern.orgUrl.matches(orgUrl), let h = URL(string: orgUrl)?.host else {
                return completion(.refused(code: "unknown_org"))
            }
            (target, host) = (.controlPlane(orgUrl: orgUrl), h)
        case .machine(let h):
            guard Pattern.hostname.matches(h) else { return completion(.refused(code: "host_invalid")) }
            (target, host) = (.machine(host: h), h)
        }
        let url: URL
        do {
            let identity = try deviceKeys.ensure(orgId)
            let (key, pk) = SealedEnvelope.generateRecipient()
            let state = Self.randomState()
            let now = clock()
            let marker = Marker(state: state, host: host, target: target.kind, createdAt: now)
            try vault.write(Self.markerNamespace, JSONEncoder().encode(marker), .standard)
            let dsig = try deviceKeys.sign(orgId, HandoffSignature.canonical(host: host, pk: pk, state: state, dts: now))
            let params = HandoffParams(pk: pk, state: state, device: deviceLabel, dk: identity.publicKey, dts: now, dsig: dsig)
            url = URL(string: HandoffUrl.build(target: target, mode: mode, fragment: fragment, params: params))!
            pending?.completion(.cancelled)
            pending = Pending(orgId: orgId, state: state, host: host, kind: target.kind, createdAt: now, key: key, completion: completion)
        } catch VaultError.locked {
            return completion(.vaultLocked)
        } catch {
            diagnostics?.append(diagLine("handoff start failed", [("error", String(describing: type(of: error)))]))
            return completion(.vaultLocked)
        }
        diagnostics?.append(diagLine("handoff started", [("host", host), ("target", target.kind)]))
        let state = pending!.state
        launcher.launch(url: url, mode: mode) { [weak self] result in self?.launcherFinished(result, state: state) }
    }

    func launcherFinished(_ result: LauncherResult, state: String) {
        switch result {
        case .redirect(let url):
            complete(callback: url)
        case .cancelled:
            finishPending(state, .cancelled)
        case .verificationFailed:
            let domain: String
            switch mode {
            case .https(let d): domain = d
            case .dev: domain = ""
            }
            finishPending(state, .verificationFailed(domain: domain))
        case .noBrowser:
            finishPending(state, .noBrowser)
        }
    }

    /// A callback URI, from the launcher or delivered out of band. Returns the outcome too.
    @discardableResult
    public func complete(callback url: URL) -> SignInOutcome {
        let taken = pending
        pending = nil
        let now = clock()
        let result = CallbackUrl.parse(mode: mode, uri: url.absoluteString,
                                       pending: taken.map { PendingState(state: $0.state, createdAt: $0.createdAt) }, now: now)
        let outcome: SignInOutcome
        switch result {
        case .refused(let reason):
            diagnostics?.append(diagLine("handoff callback refused", [("reason", reason.rawValue)]))
            outcome = reason == .noPending && markerMatches(url, now: now) ? .interrupted : .mismatch
        case .error(let code, let min, let max, let serverTime):
            let level = taken.map { deviceKeys.level($0.orgId) } ?? .software
            diagnostics?.append(diagLine("handoff refused by server", [("code", code), ("level", level.rawValue)]))
            outcome = SignInOutcome.fromCallbackError(code: code, min: min, max: max, serverTime: serverTime, level: level)
        case .success(let jwe):
            outcome = open(jwe, taken!, now: now)
        }
        try? vault.delete(Self.markerNamespace)
        diagnostics?.append(diagLine("handoff outcome", [("kind", outcome.kind)]))
        taken?.completion(outcome)
        return outcome
    }

    private func open(_ jwe: String, _ p: Pending, now: Int64) -> SignInOutcome {
        switch SealedEnvelope.open(jwe: jwe, recipient: p.key, expectedHost: p.host, expectedState: p.state,
                                   expectedKind: p.kind, now: now) {
        case .failure(let e):
            diagnostics?.append(diagLine("handoff envelope refused", [("code", e.rawValue)]))
            switch e {
            case .stateMismatch: return .mismatch
            case .expired: return .envelopeExpired
            case .malformed, .unsupported, .kidMismatch, .pointInvalid, .hostMismatch, .decryptFailed, .kindMismatch:
                return .decryptFailed(code: e.rawValue)
            }
        case .success(let payload):
            do {
                let stored = try sessions.put(orgId: p.orgId, payload: payload, kind: rung)
                return .signedIn(host: payload.host, email: payload.email, expiresAt: stored.exp)
            } catch {
                return .vaultLocked
            }
        }
    }

    private func finishPending(_ state: String, _ outcome: SignInOutcome) {
        guard let p = pending, p.state == state else { return }
        pending = nil
        try? vault.delete(Self.markerNamespace)
        diagnostics?.append(diagLine("handoff outcome", [("kind", outcome.kind)]))
        p.completion(outcome)
    }

    /// A reply for a sign-in this process no longer holds the key of (the app was closed).
    private func markerMatches(_ url: URL, now: Int64) -> Bool {
        guard let data = try? vault.read(Self.markerNamespace), let marker = try? JSONDecoder().decode(Marker.self, from: data),
              let params = CallbackUrl.params(mode: mode, uri: url.absoluteString) ?? nil, let state = params["state"]
        else { return false }
        return constantTimeEqual(Data(state.utf8), Data(marker.state.utf8)) && now - marker.createdAt <= CallbackUrl.ttlS
    }

    static func randomState() -> String {
        B64url.encode(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) })
    }
}
