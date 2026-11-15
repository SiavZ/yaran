/// Tests for App Lock around the machine window and the sign-in browser (review round 1, A and B).
///
/// The handoff client runs against Phase 14's real `AppLock` and `Vault` (in-memory Keychain),
/// fed the scene lifecycle SceneDelegate feeds it: with the lock on and grace Immediately, a
/// trip to another app during sign-in no longer relocks before the callback is stored, every
/// other ending releases the hold, and the hold dies with the callback TTL. `LockGate` keeps
/// the window's open, resume and renewal behind the lock and runs them once at the unlock.
/// Returning from Mail or an authenticator mid renewal waits for that same sign-in (P1, round 2).
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/LockTests
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/LockGate (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/RenewalCoordinator (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/StoreTests (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Darwin, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import Darwin
import Foundation
import Testing
import YaranCore
@testable import MachineViewCore

private final class LockRig {
    let host = "laptop-ada.example.com"
    let core = Vault(store: InMemoryKeychainStore(), accessGroup: nil)
    lazy var lock = AppLock(vault: core, biometry: { .available })
    lazy var secrets = VaultSecrets(core)
    let diag = MemoryDiag(), launcher = FakeLauncher()
    lazy var sessions = SessionStore(vault: secrets, diagnostics: diag, lockEnabled: { [unowned self] in self.lock.status().enabled })
    lazy var client = HandoffClient(
        vault: secrets, deviceKeys: DeviceKeyStore(backend: SoftwareKeyBackend(), installs: InstallIdStore(vault: secrets), diagnostics: diag),
        sessions: sessions, orgs: FakeOrgs(), launcher: launcher, mode: .https(domain: "app.example.com"), deviceLabel: "Ada's iPhone",
        clock: { 1_731_571_200 }, diagnostics: diag, appLock: CoreAppLock(lock))
    var outcomes: [SignInOutcome] = []
    /// CoreAppLock's continuous monotonic clock in milliseconds.
    let start = Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)

    init(grace: LockGrace = .immediately) throws {
        #expect(try lock.enable(allowPasscode: false) == .enabled)
        try lock.setOptions(grace: grace, allowPasscode: nil)
    }

    func signIn() { client.signIn(orgId: "org-a", request: .machine(host: host)) { [unowned self] in self.outcomes.append($0) } }

    /// The scene in the background from `start` to `start + awayMs` (Mail, for a one-time PIN).
    func away(_ awayMs: Int64) {
        lock.didEnterBackground(nowMs: start)
        lock.willEnterForeground(nowMs: start + awayMs)
    }

    func reply(_ result: LauncherResult) { launcher.completions.last!(result) }

    /// The machine window's renewal, reading this rig's stored session as MachineViewController does.
    lazy var renewalUi = FakeUi()
    lazy var coordinator = RenewalCoordinator(clock: { 1_731_571_200 }, scheduler: FakeScheduler(), session: { [unowned self] in
        (try? self.sessions.get(self.host)).flatMap { $0 }.map { (iat: $0.iat, exp: $0.exp) }
    }, ui: renewalUi, renew: { [unowned self] done in self.client.signIn(orgId: "org-a", request: .machine(host: self.host), completion: done) })

    /// MachineViewController's `run` and `open`: a gate step, then load, wait or renew first.
    func run(_ step: LockGate.Step) {
        let decision: OpenDecision
        switch step {
        case .none: return
        case .open: decision = coordinator.onOpen()
        case .resume: decision = coordinator.onResume()
        }
        if decision == .renewFirst { coordinator.renewNow { [unowned self] in self.outcomes.append($0) } }
    }

    func sealedReply() throws {
        let query = launcher.lastQuery
        let jwe = try Sealer.seal(pk: query["pk"]!, host: host, state: query["state"]!, payload: [
            "v": 1, "kind": "machine", "host": host, "jwt": Sealer.jwt(exp: 1_731_657_600), "email": "ada@example.org",
            "exp": 1_731_657_600, "iat": 1_731_571_200
        ])
        reply(.redirect(URL(string: "https://app.example.com/auth/callback?state=\(query["state"]!)&jwe=\(jwe)")!))
    }
}

@Suite struct LockTests {
    @Test func theBrowserTripDoesNotRelockBeforeTheCallbackIsStored() throws {
        let rig = try LockRig()
        rig.signIn()
        rig.away(300_000)
        #expect(!rig.lock.locked, "back from the app's own sign-in")
        try rig.sealedReply()
        #expect(rig.outcomes == [.signedIn(host: rig.host, email: "ada@example.org", expiresAt: 1_731_657_600)])
        #expect(try rig.sessions.get(rig.host)?.orgId == "org-a")

        rig.away(0)
        #expect(rig.lock.locked, "stored and released: a real background still locks at once")
        #expect(throws: MachineViewCore.VaultError.locked) { try rig.sessions.get(rig.host) }
    }

    @Test(arguments: [LauncherResult.cancelled, .verificationFailed, .noBrowser])
    func everyOtherEndingReleasesTheHold(ending: LauncherResult) throws {
        let rig = try LockRig()
        rig.signIn()
        rig.reply(ending)
        #expect(rig.outcomes.count == 1)
        rig.away(0)
        #expect(rig.lock.locked)
    }

    @Test func aRefusedCallbackReleasesTheHold() throws {
        let rig = try LockRig()
        rig.signIn()
        rig.reply(.redirect(URL(string: "https://app.example.com/auth/callback?state=\(rig.launcher.lastQuery["state"]!)&error=handoff_declined")!))
        #expect(rig.outcomes == [.declined])
        rig.away(0)
        #expect(rig.lock.locked)
    }

    @Test func aLongGraceTripSignsInAndAnAbandonedHoldDiesWithTheTtl() throws {
        let rig = try LockRig(grace: .oneMinute)
        rig.signIn()
        rig.away(120_000)
        try rig.sealedReply()
        #expect(!rig.lock.locked && rig.outcomes.count == 1)

        rig.signIn()
        rig.away(CallbackUrl.ttlS * 1000 + 5_000)
        #expect(rig.lock.locked, "a flow that never reported back cannot keep App Lock off")
        rig.reply(.cancelled)
    }

    @Test func theGateHoldsOpenAndResumeUntilTheUnlockThenRunsOnce() {
        var gate = LockGate()
        #expect(gate.appeared(locked: true) == .none)
        #expect(gate.becameActive(locked: true) == .none)
        #expect(gate.lockChanged(locked: false) == .open)
        #expect(gate.becameActive(locked: false) == .none, "Face ID's own resign/active cycle does not open twice")

        gate.enteredBackground()
        #expect(gate.lockChanged(locked: true) == .none)
        #expect(gate.becameActive(locked: true) == .none, "no renewal or browser behind the lock")
        #expect(gate.lockChanged(locked: false) == .resume)
        #expect(gate.becameActive(locked: false) == .none)

        gate.enteredBackground()
        #expect(gate.becameActive(locked: false) == .resume, "grace not over: resume at once")
        #expect(gate.becameActive(locked: false) == .none, "a resign without the background is no resume")
        #expect(gate.lockChanged(locked: true) == .none)
        #expect(gate.lockChanged(locked: false) == .resume, "the lock engaged over an open page")
    }

    @Test func returningMidRenewalWaitsForTheSameSignInAndReloadsOnce() throws {
        let rig = try LockRig()
        var gate = LockGate()
        rig.run(gate.appeared(locked: rig.lock.locked)) // no session yet: renew first
        #expect(rig.launcher.launched.count == 1)

        gate.enteredBackground()
        rig.away(300_000) // Mail for the one-time PIN, or an authenticator
        let step = gate.becameActive(locked: rig.lock.locked)
        #expect(step == .resume && rig.coordinator.renewing)
        rig.run(step)
        #expect(rig.launcher.launched.count == 1, "no second sign-in replaces the one the user is finishing")
        #expect(rig.outcomes.isEmpty, "the first sign-in was not cancelled")

        try rig.sealedReply()
        #expect(rig.outcomes == [.signedIn(host: rig.host, email: "ada@example.org", expiresAt: 1_731_657_600)])
        #expect(rig.renewalUi.events.filter { $0 == "reload" }.count == 1)
        #expect(!rig.coordinator.renewing)

        gate.enteredBackground()
        rig.run(gate.becameActive(locked: rig.lock.locked))
        #expect(rig.launcher.launched.count == 1 && rig.renewalUi.events.filter { $0 == "reload" }.count == 1, "a fresh session resumes by loading")
    }

    @Test func aRepeatedRenewalEndsEachOnceAndIgnoresTheStaleBrowser() throws {
        let rig = try LockRig()
        rig.coordinator.renewNow { [unowned rig] in rig.outcomes.append($0) }
        rig.coordinator.renewNow { [unowned rig] in rig.outcomes.append($0) } // Sign in pressed again
        #expect(rig.outcomes == [.cancelled] && rig.coordinator.renewing, "the replaced one ends; the newer one is still out")
        rig.launcher.completions[0](.cancelled) // the replaced browser's late cancel
        #expect(rig.outcomes.count == 1 && rig.coordinator.onResume() == .wait)

        try rig.sealedReply()
        #expect(rig.outcomes.last == .signedIn(host: rig.host, email: "ada@example.org", expiresAt: 1_731_657_600))
        #expect(rig.outcomes.count == 2 && !rig.coordinator.renewing)
        rig.away(0)
        #expect(rig.lock.locked, "the hold was released")
    }

    @Test func anUnlockedWindowOpensAtOnce() {
        var gate = LockGate()
        #expect(gate.appeared(locked: false) == .open)
        #expect(gate.lockChanged(locked: false) == .none)
    }
}
