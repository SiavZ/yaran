/// The direct session lifecycle the bridge and the window share (G1): keep a new sign-in, end
/// one. Split from `Direct.swift`; the Android twin is `DirectFlow.keep` / `DirectFlow.signOut`.
///
/// - Main actor; the network work is async.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/DirectLifecycle
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/DirectLifecycle
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/RouteTenureTests (inferred)
/// <module-headers:end>
import Foundation

enum SymmetricKeyBytes {
    static func random(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }
}

/// The direct session lifecycle the bridge and the window share (G1): keep a new sign-in, end
/// one. A cleanup names its sign-in (`signInId`) and never ends a later one; a replaced sign-in is
/// revoked. Main actor, like every caller, so a read and the write after it never interleave
/// with another sign-in; across each network await the record is read again, because another
/// sign-in can land while a revocation is on the wire.
@MainActor
public enum DirectLifecycle {
    /// `keep`, for a login that awaited the network: only when the work is still `owned` (its window
    /// did not switch or close) and nothing wrote or removed the host's record since `epoch` was
    /// read before the login. Otherwise the returned session belongs to nobody: it is revoked on the
    /// machine, nothing is stored, the newer sign-in or the removal stands, and the answer is `cancelled`.
    public static func keepIfCurrent(_ session: DirectSession, since epoch: Int, owned: () -> Bool, store: DirectSessionStore,
                                     auth: DirectAuth) async -> DirectSignInOutcome {
        guard owned(), store.epoch(session.host) == epoch else {
            _ = await auth.logout(host: session.host, token: session.token)
            return .cancelled
        }
        return await keep(session, store: store, auth: auth)
    }

    /// Keeps `session` as the host's one session and revokes the one it replaced (best effort).
    public static func keep(_ session: DirectSession, store: DirectSessionStore, auth: DirectAuth) async -> DirectSignInOutcome {
        let superseded = try? store.get(session.host)
        do {
            try store.put(session)
        } catch {
            _ = await auth.logout(host: session.host, token: session.token) // a session nobody holds must not live on the machine
            if case VaultError.locked = error { return .vaultLocked }
            return .secureStorageFailed
        }
        if let old = superseded, old.token != session.token { _ = await auth.logout(host: session.host, token: old.token) }
        return .signedIn(host: session.host, instance: session.instance, signInId: session.signInId ?? "")
    }

    /// Ends `host`'s session. With `signInId`, only that sign-in: another current record (a later
    /// sign-in, an older build's, or none) leaves everything alone and answers `notCurrent`, also
    /// when it appeared during the revocation. Without it, whatever is current goes, a session
    /// that landed during the revocation included; a record is deleted only once every session it
    /// held was revoked, so one that is still changing after three revocations is left, current,
    /// and the answer is `notCurrent`. `clear` drops the host's web data.
    public static func signOut(host: String, signInId: String?, store: DirectSessionStore, auth: DirectAuth,
                               clear: () -> Void) async -> DirectSignOutOutcome {
        guard DirectWire.isPublicHost(host) else { return .refused }
        var revoked: Set<String> = []
        var ended = false
        var settled = false
        for _ in 0..<3 {
            let current: DirectSession?
            do { current = try store.get(host) } catch VaultError.locked { return .vaultLocked } catch {
                if signInId != nil { return .notCurrent } // cannot prove it is the caller's
                current = nil
            }
            if let signInId, current?.signInId != signInId { return .notCurrent }
            guard let current, !revoked.contains(current.token) else {
                settled = true // nothing left that was not revoked; the delete below runs before any await
                break
            }
            revoked.insert(current.token)
            ended = await auth.logout(host: host, token: current.token)
        }
        guard settled else { return .notCurrent } // the newest sign-in was never revoked: it stays
        do { try store.delete(host) } catch VaultError.locked { return .vaultLocked } catch {
            clear()
            return .secureStorageFailed
        }
        clear()
        return .signedOut(serverEnded: ended)
    }

    /// What a direct window does once its session is read: ask for the password, or go on.
    public enum Settle: Equatable { case signIn, proceed }

    /// Every direct sheet-or-proceed decision (Android `RouteDriver.settleDirect`). The session is
    /// read first: a record not usable for the instance `observed` is deleted and the host's cookies
    /// cleared before anything is decided, so a sheet never opens over a stale session. The password
    /// is asked only when no fresh sign-in of this window covers an instance-less machine and the
    /// machine (or, with no status, the missing record) asks for one. Nil once the window moved on.
    public static func settle(host: String, status: DirectStatus?, observed: String?, fresh: String?, store: DirectSessionStore,
                              jar: DirectCookieJar, owned: () -> Bool) async throws -> Settle? {
        guard owned() else { return nil }
        let current = try store.current(host, instance: observed, fresh: fresh)
        if current.dropped, await !inject(host: host, dropped: true, cookie: nil, into: jar, owned: owned) { return nil }
        guard owned() else { return nil }
        if current.session?.ownFresh(observed: observed, fresh: fresh) == true { return .proceed }
        return (status.map(needsPassword) ?? (current.session == nil)) ? .signIn : .proceed
    }

    public static func needsPassword(_ status: DirectStatus) -> Bool {
        if case let .yaran(_, _, requiredHere, signedIn, _) = status { return requiredHere && !signedIn }
        return false
    }

    /// Applies a direct session read to a window's cookie jar while `owned()` holds, checked before
    /// every change and after every await: a window closed meanwhile, whose host store a newer
    /// window may already use, changes nothing more. `dropped` first removes every cookie of the
    /// host. Returns whether the window still owns the jar.
    public static func inject(host: String, dropped: Bool, cookie: HTTPCookie?, into jar: DirectCookieJar,
                              owned: () -> Bool) async -> Bool {
        if dropped {
            guard owned() else { return false }
            for old in await jar.allCookies() where old.domain == host {
                guard owned() else { return false }
                await jar.deleteCookie(old)
            }
        }
        guard owned() else { return false }
        if let cookie { await jar.setCookie(cookie) }
        return owned()
    }
}

/// The cookie store calls a direct injection makes; `WKHTTPCookieStore` in the app.
@MainActor
public protocol DirectCookieJar: AnyObject {
    func allCookies() async -> [HTTPCookie]
    func deleteCookie(_ cookie: HTTPCookie) async
    func setCookie(_ cookie: HTTPCookie) async
}
