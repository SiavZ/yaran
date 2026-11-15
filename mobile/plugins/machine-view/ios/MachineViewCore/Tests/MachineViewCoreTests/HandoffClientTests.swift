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
/// ├── MachineViewCoreTests/FormatTests (inferred)
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
                      mode: mode, deviceLabel: "Ada's iPhone", clock: { [unowned self] in self.now }, diagnostics: store.diag, appLock: nil)
    }

    func start(_ request: SignInRequest = .machine(host: "laptop-ada.example.com")) {
        client.signIn(orgId: "org-a", request: request) { [unowned self] in self.outcomes.append($0) }
    }

    var base: String {
        switch mode {
        case .https(let domain): return "https://\(domain)/auth/callback"
        case .dev: return "yaranapp://auth/callback"
        }
    }

    func reply(_ params: String, fragment: Bool = false) {
        launcher.completions.last!(.redirect(URL(string: base + (fragment ? "#" : "?") + params)!))
    }

    func sealedReply(host: String = "laptop-ada.example.com", kind: String = "machine", exp: Int64? = nil, fragment: Bool = false) throws {
        let query = launcher.lastQuery
        let expiry = exp ?? now + 86_400
        let jwe = try Sealer.seal(pk: query["pk"]!, host: host, state: query["state"]!, payload: [
            "v": 1, "kind": kind, "host": host, "jwt": Sealer.jwt(exp: expiry), "email": "ada@example.org", "exp": expiry, "iat": now
        ])
        reply("state=\(query["state"]!)&jwe=\(jwe)", fragment: fragment)
    }
}

@Suite struct HandoffClientTests {
    @Test(arguments: [false, true])
    func releaseCallbackSignsIn(fragment: Bool) throws {
        let rig = HandoffRig()
        rig.start()
        let query = rig.launcher.lastQuery
        #expect(rig.launcher.launched.last!.0.absoluteString.hasPrefix("https://laptop-ada.example.com/__yaran/handoff?v=1&"))
        #expect(query["redirect"] == "https://app.example.com/auth/callback" && query["build"] == nil && query["device"] == "Ada's iPhone")
        try rig.sealedReply(fragment: fragment)
        #expect(rig.outcomes == [.signedIn(host: "laptop-ada.example.com", email: "ada@example.org", expiresAt: rig.now + 86_400)])
        #expect(try rig.store.sessions().get("laptop-ada.example.com")?.orgId == "org-a")
        #expect(rig.store.vault.items["handoff"] == nil)
        #expect(expectClean(rig.store.diag.lines))
    }

    @Test func devCallbackSignsInAndSendsBuildDev() throws {
        let rig = HandoffRig(mode: .dev)
        rig.start()
        #expect(rig.launcher.lastQuery["build"] == "dev" && rig.launcher.lastQuery["redirect"] == "yaranapp://auth/callback")
        try rig.sealedReply()
        #expect(rig.outcomes.first?.kind == "signed_in")
    }

    @Test func controlPlaneTargetsTheWorker() throws {
        let rig = HandoffRig()
        rig.start(.controlPlane)
        #expect(rig.launcher.launched.last!.0.absoluteString.hasPrefix("https://cp.example.com/v1/handoff?"))
        try rig.sealedReply(host: "cp.example.com", kind: "control_plane")
        #expect(rig.outcomes == [.signedIn(host: "cp.example.com", email: "ada@example.org", expiresAt: rig.now + 86_400)])
    }

    @Test func requestCarriesAValidDeviceSignature() throws {
        let rig = HandoffRig()
        rig.start()
        let query = rig.launcher.lastQuery
        #expect(query["dts"] == String(rig.now))
        let key = try P256.Signing.PublicKey(x963Representation: P256Point.decode(query["dk"]!)!)
        let msg = HandoffSignature.canonical(host: "laptop-ada.example.com", pk: query["pk"]!, state: query["state"]!, dts: rig.now)
        #expect(key.isValidSignature(try P256.Signing.ECDSASignature(rawRepresentation: B64url.decode(query["dsig"]!)!), for: Data(msg.utf8)))
        #expect(query["dk"] == rig.store.keys.publicKey("org-a"))
    }

    @Test func cancelledLogin() {
        let rig = HandoffRig()
        rig.start()
        rig.launcher.completions.last!(.cancelled)
        #expect(rig.outcomes == [.cancelled])
        #expect(rig.store.vault.items["handoff"] == nil)
    }

    @Test func declinedAndClockSkew() {
        let rig = HandoffRig()
        rig.start()
        rig.reply("state=\(rig.launcher.lastQuery["state"]!)&error=handoff_declined")
        rig.start()
        rig.reply("state=\(rig.launcher.lastQuery["state"]!)&error=handoff_timestamp_skewed&server_time=1731571900")
        rig.start()
        rig.reply("state=\(rig.launcher.lastQuery["state"]!)&error=handoff_device_key_invalid")
        #expect(rig.outcomes == [.declined, .clockSkewed(serverTime: 1_731_571_900),
                               .deviceKeyRejected(code: "handoff_device_key_invalid", securityLevel: .software)])
        #expect(rig.store.diag.lines.contains { $0.contains("handoff_device_key_invalid") && $0.contains("level=software") })
    }

    @Test func stateMismatchAndWrongForm() {
        let rig = HandoffRig()
        rig.start()
        rig.reply("state=aGFuZG9mZi1zdGF0ZS1maXh0dXJlLW90aGVy&error=handoff_declined")
        rig.start()
        rig.launcher.completions.last!(.redirect(URL(string: "yaranapp://auth/callback?state=\(rig.launcher.lastQuery["state"]!)&error=rate_limited")!))
        #expect(rig.outcomes == [.mismatch, .mismatch])
    }

    @Test func ttlExpiry() throws {
        let rig = HandoffRig()
        rig.start()
        rig.now += 601
        try rig.sealedReply()
        #expect(rig.outcomes == [.mismatch])
    }

    @Test func replayIsRefused() throws {
        let rig = HandoffRig()
        rig.start()
        let query = rig.launcher.lastQuery
        let jwe = try Sealer.seal(pk: query["pk"]!, host: "laptop-ada.example.com", state: query["state"]!, payload: [
            "v": 1, "kind": "machine", "host": "laptop-ada.example.com", "jwt": Sealer.jwt(exp: rig.now + 9000),
            "email": "ada@example.org", "exp": rig.now + 9000, "iat": rig.now
        ])
        let url = URL(string: "\(rig.base)?state=\(query["state"]!)&jwe=\(jwe)")!
        #expect(rig.client.complete(callback: url).kind == "signed_in")
        #expect(rig.client.complete(callback: url) == .mismatch)
    }

    @Test func processDeathEndsInterruptedAndTheVaultNeverHoldsAKey() {
        let rig = HandoffRig()
        rig.start()
        let marker = rig.store.vault.json("handoff")!
        #expect(Set(marker.keys) == ["state", "host", "target", "created_at"])
        #expect(rig.store.vault.items.keys.allSatisfy { !$0.contains("key") })
        let state = rig.launcher.lastQuery["state"]!
        let reborn = rig.makeClient() // the old process (and its in-memory key) is gone
        #expect(reborn.complete(callback: URL(string: "\(rig.base)?state=\(state)&error=handoff_declined")!) == .interrupted)
        #expect(rig.store.vault.items["handoff"] == nil)
    }

    @Test func expiredEnvelopeAndBadEnvelope() throws {
        let rig = HandoffRig()
        rig.start()
        try rig.sealedReply(exp: rig.now + 30)
        rig.start()
        try rig.sealedReply(host: "laptop-ada.example.com", kind: "control_plane")
        #expect(rig.outcomes == [.envelopeExpired, .decryptFailed(code: "jwe_kind_mismatch")])
    }

    @Test func verificationAndNoBrowserAndLockedVault() throws {
        let rig = HandoffRig()
        rig.start()
        rig.launcher.completions.last!(.verificationFailed)
        rig.start()
        rig.launcher.completions.last!(.noBrowser)
        #expect(rig.outcomes == [.verificationFailed(domain: "app.example.com"), .noBrowser])
        let locked = HandoffRig()
        locked.store.vault.locked = true
        try locked.store.vault.write("install/org-a", Data("{}".utf8), .locked)
        locked.start()
        #expect(locked.outcomes == [.vaultLocked])
    }

    @Test func invalidTargetsAreRefusedWithoutLaunching() {
        let rig = HandoffRig()
        rig.start(.machine(host: "Bad_Host"))
        rig.orgs.urls = [:]
        rig.start(.controlPlane)
        #expect(rig.outcomes == [.refused(code: "host_invalid"), .refused(code: "unknown_org")])
        #expect(rig.launcher.launched.isEmpty)
    }

    @Test func aNewSignInReplacesThePendingOne() throws {
        let rig = HandoffRig()
        rig.start()
        rig.start()
        #expect(rig.outcomes == [.cancelled])
        try rig.sealedReply()
        #expect(rig.outcomes.last?.kind == "signed_in")
    }

    @Test func launcherIsNeverEphemeral() {
        #expect(HandoffClient.prefersEphemeralWebBrowserSession == false)
    }
}
