/// Which route a machine window's asynchronous work belongs to (G2; Sol native review round 6).
///
/// A window's probes, password sheet, sign-in, cookie changes, loads and renewals finish later
/// than they start. Each takes a ticket when it starts and acts only while that ticket is still
/// the current one: an accepted route switch or the window's close ends it, so work started for
/// route A is inert on B, and stays inert after a switch back to A. Keeping the same route is no
/// switch, so its work carries on. The page admission (`native_auth_ui`) is held per ticket too:
/// a probe that found the route's yaran able to show its page admits one load under that ticket.
///
/// - Main actor, like the window.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/RouteTenure
/// └── MachineViewCore/Direct (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/RouteTenure
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/PasswordSheetTests (inferred)
/// └── MachineViewCoreTests/RouteTenureTests (inferred)
/// <module-headers:end>
import Foundation

@MainActor
public final class RouteTenure {
    public private(set) var ticket = 0
    public private(set) var closed = false
    private var admittedFor: Int?
    private var documentPass: (ticket: Int, url: String)?

    public init() {}

    /// An accepted switch to another route: everything started before it is the old route's.
    public func switched() {
        ticket += 1
        admittedFor = nil
        documentPass = nil
    }

    public func close() { closed = true }

    public func owns(_ ticket: Int) -> Bool { !closed && ticket == self.ticket }

    /// A check bound to the ticket in force now, for work that completes later; weak, so pending
    /// work never keeps the window alive.
    public func check() -> () -> Bool {
        let mine = ticket
        return { [weak self] in self?.owns(mine) ?? false }
    }

    /// A probe under the current ticket found the route's yaran able to show its page here.
    public func admit() { admittedFor = ticket }

    /// Spends the admission: true once per admit, and only under the ticket it was given for.
    public func takeAdmission() -> Bool {
        defer { admittedFor = nil }
        return !closed && admittedFor == ticket
    }

    /// A page kept as it is, or a load that turned into a sign-in, holds no admission for later.
    public func revokeAdmission() { admittedFor = nil }

    /// The native load about to start was admitted: its own document navigation needs no second probe.
    public func passDocument(_ url: URL) { documentPass = (ticket, Self.document(url)) }

    /// Spends the pass for `url`'s document: true once, only under the ticket it was given for.
    public func takeDocumentPass(_ url: URL) -> Bool {
        defer { documentPass = nil }
        return !closed && documentPass?.ticket == ticket && documentPass?.url == Self.document(url)
    }

    private static func document(_ url: URL) -> String { url.absoluteString.components(separatedBy: "#")[0] }
}

/// What a fresh probe of the window's current route means for loading a document of it.
public enum DocumentVerdict: Equatable {
    case admit, reselect, signIn, refuse, stale

    /// The route's yaran must say its page signs in natively (a `.yaran` status) and still be the
    /// machine the window's context is for: a probe `mismatch`, or an instance other than the one
    /// `seen` at the last selection, is a new selection, never an admission that would carry the
    /// old instance's session along. No status (an org route with no usable session) is sign-in.
    /// `https://<host>` on the default port, exactly: the only origin a route's documents come from.
    /// Checked before any pass or probe, so another host, port or scheme never borrows the route's admission.
    public static func isRouteOrigin(_ url: URL, host: String) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == host.lowercased() && (url.port == nil || url.port == 443)
    }

    public static func of(probe: Probe, status: DirectStatus?, seen: String?) -> DocumentVerdict {
        switch status {
        case let .yaran(answered, _, _, _, _) where probe == .mismatch || (seen != nil && answered != seen): return .reselect
        case .yaran: return .admit
        case nil: return .signIn
        case .some: return .refuse
        }
    }
}
