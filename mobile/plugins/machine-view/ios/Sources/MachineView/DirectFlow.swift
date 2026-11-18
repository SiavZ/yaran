/// The direct-machine flows behind `Session.directStatus/directSignIn/directSignOut/routeStatus`
/// and the machine window's own sign-in (G1, G2); the iOS twin of `DirectFlow.kt`.
///
/// Sign-in refuses a host that holds an org session (`org_host`), probes the public status with
/// nothing attached, and only for a yaran that wants a password on this route shows the native
/// sheet: a `UIAlertController` with a secure text field that password managers may fill. The
/// password becomes UTF-8 bytes for the one POST and is zeroed after it; Swift strings cannot
/// be wiped, so the field's own copy lives only as long as the alert. The session is kept under
/// `session-direct/<host>`; a token the phone could not keep is revoked at once. Sign-out ends
/// the session on the machine (best effort), deletes the record and removes the host's whole
/// WebKit data store.
///
/// - Main actor; the network work is async.
///
/// <module-headers:begin>
/// Uses:
/// MachineView/DirectFlow
/// ├── MachineView/AppServices (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectLifecycle (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/PendingChooser (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: UIKit
///
/// Used by:
/// MachineView/DirectFlow
/// ├── MachineView/MachineViewController+Direct (inferred)
/// └── MachineView/SessionPlugin (inferred)
/// <module-headers:end>
import MachineViewCore
import UIKit

@MainActor
enum DirectFlow {
    private static var services: AppServices { .shared }

    static func hasOrgSession(_ host: String) -> Bool {
        do { return try services.sessions.get(host) != nil } catch { return true } // locked or unreadable still counts
    }

    static func status(host: String) async -> DirectStatus {
        guard DirectWire.isPublicHost(host) else { return .refused(reason: "invalid_host") }
        if hasOrgSession(host) { return .refused(reason: "org_host") }
        let stored: DirectSession?
        do { stored = try services.directSessions.get(host) } catch VaultError.locked { return .vaultLocked } catch {
            services.diagnostics?.append(diagLine("direct session unreadable", [("host", host)]))
            stored = nil
        }
        return await services.directAuth.status(host: host, stored: stored)
    }

    static func routeStatus(_ route: MachineRoute) async -> [String: Any] {
        switch route {
        case .direct(let host): return await status(host: host).jsObject
        case let .org(orgId, _, host):
            do {
                let status = try await services.directAuth.orgRouteStatus(orgId: orgId, host: host, sessions: services.sessions, now: AppServices.now())
                return status?.jsObject ?? ["kind": "sign_in_required"]
            } catch {
                return DirectStatus.vaultLocked.jsObject
            }
        }
    }

    /// `presenter` that left the screen meanwhile (a closed window) gets no sheet: `cancelled`. So does
    /// work the window no longer `owned` (it switched routes): checked before the sheet, at its
    /// submit and before the POST, so an old route's sheet never shows or posts over a new one.
    static func signIn(from presenter: UIViewController, host: String, owned: @escaping () -> Bool = { true },
                       onSheet: @escaping (PendingSheet) -> Void = { _ in }, done: @escaping (DirectSignInOutcome) -> Void) {
        Task { @MainActor in
            guard DirectWire.isPublicHost(host) else { return done(.refused(reason: "invalid_host")) }
            if hasOrgSession(host) { return done(.refused(reason: "org_host")) }
            let first = await services.directAuth.status(host: host, stored: nil) // nothing attached before the answer proves a yaran
            guard case let .yaran(instance, _, requiredHere, _, _) = first else { return done(first.asSignIn) }
            guard requiredHere else { return done(.notRequired) }
            guard owned(), presenter.viewIfLoaded?.window != nil, !presenter.isBeingDismissed else { return done(.cancelled) }
            sheet(on: presenter, host: host, onSheet: onSheet) { password in
                guard var bytes = password, owned() else { return done(.cancelled) }
                Task { @MainActor in
                    guard owned() else {
                        bytes.resetBytes(in: 0..<bytes.count)
                        return done(.cancelled)
                    }
                    done(await post(host: host, password: &bytes, instance: instance, owned: owned))
                }
            }
        }
    }

    /// `onSheet` gets the sheet's `PendingSheet`, so its window can answer and dismiss it when it goes.
    private static func sheet(on presenter: UIViewController, host: String, onSheet: (PendingSheet) -> Void,
                              done: @escaping ([UInt8]?) -> Void) {
        let row = Messages.overlay["password_sheet"] ?? Messages.Row(message: "", actions: ["sign_in", "cancel"])
        let alert = UIAlertController(title: "Sign in to \(host)", message: Messages.fill(row.message, ["host": host, "machine": host]),
                                      preferredStyle: .alert)
        alert.addTextField { field in
            field.isSecureTextEntry = true
            field.textContentType = .password
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        let pending = PendingSheet(dismiss: { [weak alert] in alert?.dismiss(animated: false) }, answer: done)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in pending.respond(nil) })
        alert.addAction(UIAlertAction(title: "Sign in", style: .default) { [weak alert] _ in
            let field = alert?.textFields?.first
            let bytes = Array((field?.text ?? "").utf8)
            field?.text = nil
            pending.respond(bytes)
        })
        onSheet(pending)
        (presenter.presentedViewController ?? presenter).present(alert, animated: true)
    }

    /// The record's epoch is read before the login: a sign-in or removal that lands while it is on
    /// the wire, or the window moving on (`owned`), makes its session nobody's (`keepIfCurrent`).
    private static func post(host: String, password: inout [UInt8], instance: String?, owned: @escaping () -> Bool) async -> DirectSignInOutcome {
        var body = DirectWire.loginBody(password: &password, label: "yaran phone (\(services.deviceLabel))")
        let epoch = services.directSessions.epoch(host)
        let answer = await services.directAuth.login(host: host, body: body)
        body.resetBytes(in: 0..<body.count)
        switch answer {
        case .failed(let outcome, _): return outcome
        case let .token(token, cookieName):
            let session = DirectSession(host: host, token: token, cookieName: cookieName, instance: instance, issuedAt: AppServices.now(),
                                        signInId: DirectSession.newSignInId())
            let outcome = await DirectLifecycle.keepIfCurrent(session, since: epoch, owned: owned, store: services.directSessions,
                                                               auth: services.directAuth)
            services.diagnostics?.append(diagLine("direct sign-in", [("host", host), ("outcome", outcome.kind)]))
            return outcome
        }
    }

    /// With `signInId`, ends only that sign-in (`notCurrent` otherwise, nothing touched); without
    /// it, whatever is current. The host's whole data store goes with it (`DirectLifecycle.signOut`).
    static func signOut(host: String, signInId: String?) async -> DirectSignOutOutcome {
        let outcome = await DirectLifecycle.signOut(host: host, signInId: signInId, store: services.directSessions, auth: services.directAuth) {
            services.cleaner.clear(hosts: [host])
        }
        services.diagnostics?.append(diagLine("direct sign-out", [("host", host), ("outcome", String(describing: outcome))]))
        return outcome
    }

    /// The host-only, session-scoped `yaran_session_<port>` cookie for the window's own store.
    static func cookie(_ session: DirectSession) -> HTTPCookie? {
        guard session.setCookie != nil else { return nil }
        return HTTPCookie(properties: [
            .name: session.cookieName, .value: session.token, .domain: session.host, .path: "/", .secure: "TRUE",
            .discard: "TRUE", .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict, HTTPCookiePropertyKey("HttpOnly"): "TRUE"
        ])
    }
}
