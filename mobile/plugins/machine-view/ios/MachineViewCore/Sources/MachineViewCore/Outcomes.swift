/// The plugin's result unions, matching `src/outcomes.ts` kind for kind.
///
/// `SignInOutcome` is what `Session.signIn` resolves with, `ApiResult` what `Session.request`
/// and `Session.meta` resolve with. `jsObject` is the exact dictionary the Capacitor adapter
/// hands to JS, so the TypeScript unions and these enums stay one contract.
///
/// - No case carries a JWT, a cookie or a key (D22).
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/Outcomes
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/NativeOrgApi (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCore/SecureEnclaveBackend (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// └── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// <module-headers:end>
import Foundation

public enum SecurityLevel: String, Codable, Equatable {
    case strongbox, tee
    case secureEnclave = "secure_enclave"
    case software
}

public enum SignInOutcome: Equatable {
    case signedIn(host: String, email: String, expiresAt: Int64)
    case cancelled, declined, interrupted
    case verificationFailed(domain: String)
    case rateLimited
    case protocolUnsupported(min: Int?, max: Int?)
    case clockSkewed(serverTime: Int64?)
    case deviceKeyRejected(code: String, securityLevel: SecurityLevel)
    case refused(code: String)
    case noBrowser, mismatch
    case decryptFailed(code: String)
    case envelopeExpired
    case notOwner(email: String?)
    case offline, tlsError, vaultLocked

    public var kind: String {
        switch self {
        case .signedIn: return "signed_in"
        case .cancelled: return "cancelled"
        case .declined: return "declined"
        case .interrupted: return "interrupted"
        case .verificationFailed: return "verification_failed"
        case .rateLimited: return "rate_limited"
        case .protocolUnsupported: return "protocol_unsupported"
        case .clockSkewed: return "clock_skewed"
        case .deviceKeyRejected: return "device_key_rejected"
        case .refused: return "refused"
        case .noBrowser: return "no_browser"
        case .mismatch: return "mismatch"
        case .decryptFailed: return "decrypt_failed"
        case .envelopeExpired: return "envelope_expired"
        case .notOwner: return "not_owner"
        case .offline: return "offline"
        case .tlsError: return "tls_error"
        case .vaultLocked: return "vault_locked"
        }
    }

    public var jsObject: [String: Any] {
        var o: [String: Any] = ["kind": kind]
        switch self {
        case .signedIn(let host, let email, let expiresAt):
            o["host"] = host; o["email"] = email; o["expiresAt"] = expiresAt
        case .verificationFailed(let domain): o["domain"] = domain
        case .protocolUnsupported(let min, let max): o["min"] = min; o["max"] = max
        case .clockSkewed(let serverTime): o["serverTime"] = serverTime
        case .deviceKeyRejected(let code, let level): o["code"] = code; o["securityLevel"] = level.rawValue
        case .refused(let code), .decryptFailed(let code): o["code"] = code
        case .notOwner(let email): o["email"] = email
        case .cancelled, .declined, .interrupted, .rateLimited, .noBrowser, .mismatch, .envelopeExpired, .offline,
             .tlsError, .vaultLocked:
            break
        }
        return o.compactMapValues { $0 }
    }

    /// The callback `error` code's outcome (Phase 15 Failure matrix).
    public static func fromCallbackError(code: String, min: Int?, max: Int?, serverTime: Int64?,
                                         level: SecurityLevel) -> SignInOutcome {
        switch code {
        case "handoff_declined": return .declined
        case "rate_limited": return .rateLimited
        case "protocol_unsupported": return .protocolUnsupported(min: min, max: max)
        case "handoff_timestamp_skewed": return .clockSkewed(serverTime: serverTime)
        case "handoff_device_key_invalid", "handoff_signature_malformed": return .deviceKeyRejected(code: code, securityLevel: level)
        case "handoff_owner_mismatch": return .notOwner(email: nil)
        default: return .refused(code: code)
        }
    }
}

public enum RefusedReason: String, Equatable {
    case unknownOrg = "unknown_org", origin, method, path
    case bodyInvalid = "body_invalid", bodyInstallId = "body_install_id", bodyDeviceKey = "body_device_key"
    case responseTooLarge = "response_too_large", notJson = "not_json"
}

public enum ApiResult {
    case ok(status: Int, body: Any?)
    /// `error` is the Phase 02 ErrorEnvelope object.
    case apiError(status: Int, error: [String: Any])
    case sessionExpired, deviceRevoked, offline, tlsError
    case refused(RefusedReason)
    case protocolUnsupported(min: Int?, max: Int?)

    public var kind: String {
        switch self {
        case .ok: return "ok"
        case .apiError: return "api_error"
        case .sessionExpired: return "session_expired"
        case .deviceRevoked: return "device_revoked"
        case .offline: return "offline"
        case .tlsError: return "tls_error"
        case .refused: return "refused"
        case .protocolUnsupported: return "protocol_unsupported"
        }
    }

    public var jsObject: [String: Any] {
        var o: [String: Any] = ["kind": kind]
        switch self {
        case .ok(let status, let body): o["status"] = status; o["body"] = body ?? NSNull()
        case .apiError(let status, let error): o["status"] = status; o["error"] = error
        case .refused(let reason): o["reason"] = reason.rawValue
        case .protocolUnsupported(let min, let max):
            if let min { o["min"] = min }
            if let max { o["max"] = max }
        case .sessionExpired, .deviceRevoked, .offline, .tlsError: break
        }
        return o
    }
}
