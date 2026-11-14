/// Work item 5 tests: the handoff orchestrator driven through a fake launcher.
///
/// Success on the release https and dev custom-scheme callbacks (query and fragment),
/// cancellation, the declined and clock-skew errors, state mismatch, the other build's form,
/// TTL expiry, replay, the interrupted outcome after a simulated process death (with no key
/// material in the vault at any point), the device signature on the request, and a launcher
/// that is never ephemeral.
///
/// - In-memory seams; envelopes sealed by the test like the servers seal them.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/HandoffClientTests
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/CallbackUrl (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/HandoffSignature (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import CryptoKit
import Foundation
import Testing
@testable import MachineViewCore

final class HandoffRig {
    let store = StoreRig()
    let orgs = FakeOrgs(), launcher = FakeLauncher()
    var now: Int64 = 1_731_571_200
    var outcomes: [SignInOutcome] = []
    let mode: CallbackMode
    lazy var client = makeClient()

    init(mode: CallbackMode = .https(domain: "app.example.com")) { self.mode = mode }

    func makeClient() -> HandoffClient {
        HandoffClient(vault: store.vault, deviceKeys: store.keys, sessions: store.sessions(), orgs: orgs, launcher: launcher,
                      mode: mode, deviceLabel: "Ada's iPhone", clock: { [unowned self] in self.now }, diagnostics: store.diag)
    }

    func start(_ request: SignInRequest = .machine(host: "laptop-ada.example.com")) {
        client.signIn(orgId: "org-a", request: request) { [unowned self] in self.outcomes.append($0) }
    }

    var base: String {
        switch mode {
        case .https(let d): return "https://\(d)/auth/callback"
        case .dev: return "yaranapp://auth/callback"
        }
    }

    func reply(_ params: String, fragment: Bool = false) {
        launcher.completions.last!(.redirect(URL(string: base + (fragment ? "#" : "?") + params)!))
    }

    func sealedReply(host: String = "laptop-ada.example.com", kind: String = "machine", exp: Int64? = nil, fragment: Bool = false) {
        let q = launcher.lastQuery
        let e = exp ?? now + 86_400
        let jwe = try! Sealer.seal(pk: q["pk"]!, host: host, state: q["state"]!, payload: [
            "v": 1, "kind": kind, "host": host, "jwt": Sealer.jwt(exp: e), "email": "ada@example.org", "exp": e, "iat": now,
        ])
        reply("state=\(q["state"]!)&jwe=\(jwe)", fragment: fragment)
    }
}

@Suite struct HandoffClientTests {
    @Test(arguments: [false, true])
    func releaseCallbackSignsIn(fragment: Bool) throws {
        let r = HandoffRig()
        r.start()
        let q = r.launcher.lastQuery
        #expect(r.launcher.launched.last!.0.absoluteString.hasPrefix("https://laptop-ada.example.com/__yaran/handoff?v=1&"))
        #expect(q["redirect"] == "https://app.example.com/auth/callback" && q["build"] == nil && q["device"] == "Ada's iPhone")
        r.sealedReply(fragment: fragment)
        #expect(r.outcomes == [.signedIn(host: "laptop-ada.example.com", email: "ada@example.org", expiresAt: r.now + 86_400)])
        #expect(try r.store.sessions().get("laptop-ada.example.com")?.orgId == "org-a")
        #expect(r.store.vault.items["handoff"] == nil)
        #expect(expectClean(r.store.diag.lines))
    }

    @Test func devCallbackSignsInAndSendsBuildDev() {
        let r = HandoffRig(mode: .dev)
        r.start()
        #expect(r.launcher.lastQuery["build"] == "dev" && r.launcher.lastQuery["redirect"] == "yaranapp://auth/callback")
        r.sealedReply()
        #expect(r.outcomes.first?.kind == "signed_in")
    }

    @Test func controlPlaneTargetsTheWorker() {
        let r = HandoffRig()
        r.start(.controlPlane)
        #expect(r.launcher.launched.last!.0.absoluteString.hasPrefix("https://cp.example.com/v1/handoff?"))
        r.sealedReply(host: "cp.example.com", kind: "control_plane")
        #expect(r.outcomes == [.signedIn(host: "cp.example.com", email: "ada@example.org", expiresAt: r.now + 86_400)])
    }

    @Test func requestCarriesAValidDeviceSignature() throws {
        let r = HandoffRig()
        r.start()
        let q = r.launcher.lastQuery
        #expect(q["dts"] == String(r.now))
        let key = try P256.Signing.PublicKey(x963Representation: P256Point.decode(q["dk"]!)!)
        let msg = HandoffSignature.canonical(host: "laptop-ada.example.com", pk: q["pk"]!, state: q["state"]!, dts: r.now)
        #expect(key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: B64url.decode(q["dsig"]!)!), for: Data(msg.utf8)))
        #expect(q["dk"] == r.store.keys.publicKey("org-a"))
    }

    @Test func cancelledLogin() {
        let r = HandoffRig()
        r.start()
        r.launcher.completions.last!(.cancelled)
        #expect(r.outcomes == [.cancelled])
        #expect(r.store.vault.items["handoff"] == nil)
    }

    @Test func declinedAndClockSkew() {
        let r = HandoffRig()
        r.start()
        r.reply("state=\(r.launcher.lastQuery["state"]!)&error=handoff_declined")
        r.start()
        r.reply("state=\(r.launcher.lastQuery["state"]!)&error=handoff_timestamp_skewed&server_time=1731571900")
        r.start()
        r.reply("state=\(r.launcher.lastQuery["state"]!)&error=handoff_device_key_invalid")
        #expect(r.outcomes == [.declined, .clockSkewed(serverTime: 1_731_571_900),
                               .deviceKeyRejected(code: "handoff_device_key_invalid", securityLevel: .software)])
        #expect(r.store.diag.lines.contains { $0.contains("handoff_device_key_invalid") && $0.contains("level=software") })
    }

    @Test func stateMismatchAndWrongForm() {
        let r = HandoffRig()
        r.start()
        r.reply("state=aGFuZG9mZi1zdGF0ZS1maXh0dXJlLW90aGVy&error=handoff_declined")
        r.start()
        r.launcher.completions.last!(.redirect(URL(string: "yaranapp://auth/callback?state=\(r.launcher.lastQuery["state"]!)&error=rate_limited")!))
        #expect(r.outcomes == [.mismatch, .mismatch])
    }

    @Test func ttlExpiry() {
        let r = HandoffRig()
        r.start()
        r.now += 601
        r.sealedReply()
        #expect(r.outcomes == [.mismatch])
    }

    @Test func replayIsRefused() {
        let r = HandoffRig()
        r.start()
        let q = r.launcher.lastQuery
        let jwe = try! Sealer.seal(pk: q["pk"]!, host: "laptop-ada.example.com", state: q["state"]!, payload: [
            "v": 1, "kind": "machine", "host": "laptop-ada.example.com", "jwt": Sealer.jwt(exp: r.now + 9000),
            "email": "ada@example.org", "exp": r.now + 9000, "iat": r.now,
        ])
        let url = URL(string: "\(r.base)?state=\(q["state"]!)&jwe=\(jwe)")!
        #expect(r.client.complete(callback: url).kind == "signed_in")
        #expect(r.client.complete(callback: url) == .mismatch)
    }

    @Test func processDeathEndsInterruptedAndTheVaultNeverHoldsAKey() {
        let r = HandoffRig()
        r.start()
        let marker = r.store.vault.json("handoff")!
        #expect(Set(marker.keys) == ["state", "host", "target", "created_at"])
        #expect(r.store.vault.items.keys.allSatisfy { !$0.contains("key") })
        let state = r.launcher.lastQuery["state"]!
        let reborn = r.makeClient() // the old process (and its in-memory key) is gone
        #expect(reborn.complete(callback: URL(string: "\(r.base)?state=\(state)&error=handoff_declined")!) == .interrupted)
        #expect(r.store.vault.items["handoff"] == nil)
    }

    @Test func expiredEnvelopeAndBadEnvelope() {
        let r = HandoffRig()
        r.start()
        r.sealedReply(exp: r.now + 30)
        r.start()
        r.sealedReply(host: "laptop-ada.example.com", kind: "control_plane")
        #expect(r.outcomes == [.envelopeExpired, .decryptFailed(code: "jwe_kind_mismatch")])
    }

    @Test func verificationAndNoBrowserAndLockedVault() {
        let r = HandoffRig()
        r.start()
        r.launcher.completions.last!(.verificationFailed)
        r.start()
        r.launcher.completions.last!(.noBrowser)
        #expect(r.outcomes == [.verificationFailed(domain: "app.example.com"), .noBrowser])
        let locked = HandoffRig()
        locked.store.vault.locked = true
        try! locked.store.vault.write("install/org-a", Data("{}".utf8), .locked)
        locked.start()
        #expect(locked.outcomes == [.vaultLocked])
    }

    @Test func invalidTargetsAreRefusedWithoutLaunching() {
        let r = HandoffRig()
        r.start(.machine(host: "Bad_Host"))
        r.orgs.urls = [:]
        r.start(.controlPlane)
        #expect(r.outcomes == [.refused(code: "host_invalid"), .refused(code: "unknown_org")])
        #expect(r.launcher.launched.isEmpty)
    }

    @Test func aNewSignInReplacesThePendingOne() {
        let r = HandoffRig()
        r.start()
        r.start()
        #expect(r.outcomes == [.cancelled])
        r.sealedReply()
        #expect(r.outcomes.last?.kind == "signed_in")
    }

    @Test func launcherIsNeverEphemeral() {
        #expect(HandoffClient.prefersEphemeralWebBrowserSession == false)
    }
}
