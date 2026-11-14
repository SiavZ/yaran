/// The sealed-handoff request URL (Phase 02 §8 `HandoffQuery`, D24 device signature fields).
///
/// Control plane: `<orgUrl>/v1/handoff` (W16); machine: `https://<host>/__yaran/handoff` (Y1).
/// The redirect is the build's callback (`CallbackMode`), `build=dev` rides only in builds
/// without a publisher domain, and `mode=fragment` only when G13 asks for it. Pinned by
/// `fixtures/handoff-url-cases.json` and the protocol's redirect allowlist fixture.
///
/// - Pure. Values are percent-encoded keeping only RFC 3986 unreserved characters.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/HandoffUrl
/// └── MachineViewCore/CallbackUrl (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/HandoffUrl
/// ├── MachineViewCore/HandoffClient (inferred)
/// └── MachineViewCoreTests/FormatTests (inferred)
/// <module-headers:end>
import Foundation

public enum HandoffTarget: Equatable {
    case controlPlane(orgUrl: String)
    case machine(host: String)

    /// The payload `kind` the envelope must carry for this target.
    public var kind: String {
        switch self {
        case .controlPlane: return "control_plane"
        case .machine: return "machine"
        }
    }
}

public struct HandoffParams: Equatable {
    public let pk: String, state: String, device: String, dk: String, dts: Int64, dsig: String
    public init(pk: String, state: String, device: String, dk: String, dts: Int64, dsig: String) {
        (self.pk, self.state, self.device, self.dk, self.dts, self.dsig) = (pk, state, device, dk, dts, dsig)
    }
}

public enum HandoffUrl {
    public static let devRedirect = "yaranapp://auth/callback"

    public static func redirect(_ mode: CallbackMode) -> String {
        switch mode {
        case .https(let domain): return "https://\(domain)/auth/callback"
        case .dev: return devRedirect
        }
    }

    public static func build(target: HandoffTarget, mode: CallbackMode, fragment: Bool, params: HandoffParams) -> String {
        let base: String
        switch target {
        case .controlPlane(let orgUrl): base = "\(orgUrl)/v1/handoff"
        case .machine(let host): base = "https://\(host)/__yaran/handoff"
        }
        var pairs: [(String, String)] = [
            ("v", "1"), ("pk", params.pk), ("state", params.state), ("redirect", redirect(mode)),
            ("device", params.device), ("dk", params.dk), ("dts", String(params.dts)), ("dsig", params.dsig),
        ]
        if case .dev = mode { pairs.append(("build", "dev")) }
        if fragment { pairs.append(("mode", "fragment")) }
        return base + "?" + pairs.map { "\($0.0)=\(encode($0.1))" }.joined(separator: "&")
    }

    static func encode(_ s: String) -> String {
        var out = ""
        for b in s.utf8 {
            let c = Character(Unicode.Scalar(b))
            if b < 0x80 && (c.isLetter || c.isNumber || "-_.~".contains(c)) { out.append(c) } else { out += String(format: "%%%02X", b) }
        }
        return out
    }
}
