/// DirectTests: the iOS twins of the direct-machine, route, cover, share-inbox and
/// storage-failure rules, against the fixtures the Kotlin tests read too.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/DirectTests
/// ├── MachineViewCore/CoverState (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/DirectAuth (inferred)
/// ├── MachineViewCore/DirectSessionStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/InstallIdStore (inferred)
/// ├── MachineViewCore/Messages (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/Outcomes (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCore/ShareInbox (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// ├── MachineViewCoreTests/OrgWipeTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// MachineViewCoreTests/DirectTests
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/DirectRepairTests (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// ├── MachineViewCoreTests/OrgApiClientTests (inferred)
/// ├── MachineViewCoreTests/PolicyTests (inferred)
/// ├── MachineViewCoreTests/RenewalCoordinatorTests (inferred)
/// └── MachineViewCoreTests/WindowSlotTests (inferred)
/// <module-headers:end>
import Foundation
import Testing
@testable import MachineViewCore

private func body(_ row: [String: Any]) throws -> Data {
    if let text = row["body_text"] as? String { return Data(text.utf8) }
    if let obj = row["body"] { return try JSONSerialization.data(withJSONObject: obj) }
    return Data()
}

/// Both sides as JSON text per key, so 42 and 42.0 or NSNull and nil compare alike.
private func same(_ want: [String: Any], _ got: [String: Any]) -> Bool {
    guard Set(want.keys) == Set(got.keys) else { return false }
    let text = { (value: Any) in (try? JSONSerialization.data(withJSONObject: [value])).flatMap { String(bytes: $0, encoding: .utf8) } }
    return want.allSatisfy { text($0.value) == text(got[$0.key]!) }
}

@Suite struct DirectFixtureTests {
    let fixture = Fixtures.plugin("direct-cases.json")

    @Test func statusAnswers() throws {
        for row in try #require(fixture["status"] as? [[String: Any]]) {
            let got = DirectWire.classifyStatus(status: try #require(row["status"] as? Int), location: row["location"] as? String,
                                                contentType: row["content_type"] as? String, body: try body(row))
            #expect(same(try #require(row["want"] as? [String: Any]), got.jsObject), "\(row["name"]!)")
        }
    }

    @Test func loginAnswers() throws {
        for row in try #require(fixture["login"] as? [[String: Any]]) {
            let name = try #require(row["name"] as? String)
            let want = try #require(row["want"] as? [String: Any])
            switch DirectWire.classifyLogin(status: try #require(row["status"] as? Int), location: row["location"] as? String,
                                            contentType: row["content_type"] as? String, body: try body(row)) {
            case let .token(token, cookieName):
                let store = try #require(row["store"] as? [String: Any])
                #expect(want["kind"] as? String == "signed_in" && token == store["token"] as? String && cookieName == store["cookie_name"] as? String, "\(name)")
                #expect(!LoginAnswer.token(token, cookieName: cookieName).description.contains(token))
            case let .failed(outcome, revoke):
                #expect(same(want, outcome.jsObject), "\(name)")
                if let should = row["revoke"] as? Bool { #expect((revoke != nil) == should, "\(name)") }
            }
        }
        let long = try #require(fixture["long_message"] as? [String: Any])
        let raw = String(repeating: try #require(long["repeat"] as? String), count: try #require(long["times"] as? Int))
        #expect(DirectWire.cleanMessage(raw).unicodeScalars.count == (try #require(long["want_length"] as? Int)))
    }

    @Test func sessionCookie() throws {
        for row in try #require(fixture["cookie"] as? [[String: Any]]) {
            let token = try #require((row["token_length"] as? Int).map { String(repeating: "a", count: $0) } ?? row["token"] as? String)
            let got = DirectWire.setCookie(name: try #require(row["name"] as? String), token: token)
            if row["set_cookie_ok"] as? Bool == true { #expect(got != nil) } else { #expect(got == row["set_cookie"] as? String, "\(row)") }
        }
    }

    @Test func publicHostsFollowTheProtocolRule() throws {
        let rows = try #require(Fixtures.proto("fixtures/uri/add-machine.json")["build"] as? [[String: Any]])
        #expect(rows.count > 5)
        for row in rows {
            let host = try #require(row["host"] as? String)
            #expect(DirectWire.isPublicHost(host) == !(row["expect"] is NSNull), "\(host)")
        }
    }

    @Test func routeChoice() throws {
        for row in try #require(fixture["routes"] as? [[String: Any]]) {
            let probes = try #require(row["probes"] as? [String]).map { Probe(rawValue: $0)! }
            var probed: [Int] = []
            let current = row["mode"] as? String == "open" ? nil : row["current"] as? Int
            let got = RouteSelector.select(count: probes.count, current: current) { probed.append($0); return probes[$0] }
            let want = try #require(row["want"] as? [String: Any])
            let index = want["index"] as? Int ?? -1
            let expected: Selection = switch try #require(want["kind"] as? String) {
            case "chosen": .chosen(index)
            case "kept": .kept(index)
            case "sign_in_first": .signInFirst(index)
            default: .noRoute
            }
            #expect(got == expected, "\(row["name"]!)")
            if let order = row["probed"] as? [Int] { #expect(probed == order, "\(row["name"]!)") }
        }
        let yaran = DirectStatus.yaran(instance: "i1", passwordSet: true, requiredHere: true, signedIn: false, transportEncrypted: true)
        #expect(RouteSelector.probe(of: yaran, instance: "i1") == .matchSignIn)
        #expect(RouteSelector.probe(of: yaran, instance: "i2") == .mismatch)
        #expect(RouteSelector.probe(of: .accessRequired, instance: nil) == .unreachable)
    }

    @Test func theLoginBodyCarriesThePasswordExactly() throws {
        var password = Array("p\"w\\d\u{1}é😀".utf8)
        let data = DirectWire.loginBody(password: &password, label: "yaran phone (Ada's \"iPhone\")")
        #expect(password.allSatisfy { $0 == 0 }, "the caller's bytes are zeroed")
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: String])
        #expect(obj == ["password": "p\"w\\d\u{1}é😀", "label": "yaran phone (Ada's \"iPhone\")"])
    }

    @Test func messagesCoverTheDirectSection() throws {
        let direct = try #require(fixture.isEmpty ? nil : Fixtures.plugin("messages.json")["direct"] as? [String: String])
        #expect(direct == Messages.direct)
        let kinds: [DirectSignInOutcome] = [.cancelled, .wrongPassword(message: ""), .rateLimited(retryAfterSeconds: 1, message: ""),
            .noPassword(message: ""), .serverRefused(status: 1, code: "c", message: ""), .notYaran, .accessRequired, .redirected,
            .offline, .tlsError, .vaultLocked, .refused(reason: "r"), .secureStorageFailed]
        for outcome in kinds { #expect(Messages.direct[outcome.kind] != nil, "\(outcome.kind)") }
    }
}

@Suite struct ClosedPayloadTests {
    @Test func aCloseNamesTheHostItConcerns() {
        let rejected = ClosedPayload.make(reason: "error", code: "instance_changed", routes: ["a.example.com"], chosen: 0)
        #expect(rejected as NSDictionary == ["reason": "error", "code": "instance_changed", "host": "a.example.com", "requestedHost": "a.example.com"])
        let none = ClosedPayload.make(reason: "error", code: "no_route", routes: ["a.example.com", "b.example.com"], chosen: 0)
        #expect(none as NSDictionary == ["reason": "error", "code": "no_route", "requestedHost": "a.example.com"])
        let routed = ClosedPayload.make(reason: "user", code: nil, routes: ["a.example.com", "b.example.com"], chosen: 1)
        #expect(routed as NSDictionary == ["reason": "user", "host": "b.example.com", "requestedHost": "a.example.com"])
    }
}

@Suite struct DirectStoreTests {
    @Test func theRecordStaysNativeAndSaysWhenItIsUnreadable() throws {
        let vault = MemoryVault()
        let store = DirectSessionStore(vault: vault)
        try store.put(DirectSession(host: "yaran.example.com", token: "tok_EN-1", cookieName: "yaran_session_443", instance: "i1", issuedAt: 7))
        #expect(Array(vault.items.keys) == ["session-direct/yaran.example.com"])
        #expect(vault.items["session-direct/yaran.example.com"]?.1 == .locked)
        #expect(DirectSessionStore.prefix.hasPrefix("session"))
        let back = try #require(try store.get("yaran.example.com"))
        #expect(back.token == "tok_EN-1" && !back.description.contains("tok_EN-1"))
        #expect(try store.get("other.example.com") == nil)
        vault.locked = true
        #expect(throws: VaultError.locked) { try store.get("yaran.example.com") }
        #expect(store.has("yaran.example.com"))
        vault.locked = false
        vault.items["session-direct/yaran.example.com"] = (Data("{nope".utf8), .standard)
        #expect(throws: StoredRecordError.unreadable) { try store.get("yaran.example.com") }
        let other = DirectSession(host: "evil.example.com", token: "t", cookieName: "yaran_session_443", instance: nil, issuedAt: 1)
        vault.items["session-direct/yaran.example.com"] = (try JSONEncoder().encode(other), .standard)
        #expect(throws: StoredRecordError.unreadable) { try store.get("yaran.example.com") }
    }

    @Test func anUnreadableOrgSessionIsNotAMissingOne() throws {
        let vault = MemoryVault()
        let sessions = SessionStore(vault: vault, diagnostics: nil)
        #expect(try sessions.get("laptop.example.com") == nil)
        vault.items["session/laptop.example.com"] = (Data("{garbage".utf8), .standard)
        #expect(throws: StoredRecordError.unreadable) { try sessions.get("laptop.example.com") }
        #expect(sessions.status("laptop.example.com", now: 0).signedIn == false)
    }
}

@Suite struct CoverAndShareTests {
    @Test func thePageReturnsOnlyWhenNoCoverIsUp() {
        var covers = CoverState()
        #expect(covers.set(lock: true) == .detach)
        #expect(covers.set(privacy: true) == .none)
        #expect(covers.set(lock: false) == .none, "the privacy cover still hides the page")
        #expect(!covers.pageAttached)
        #expect(covers.set(privacy: false) == .attach)
        #expect(covers.set(privacy: true) == .detach)
        #expect(covers.set(privacy: true) == .none)
        #expect(covers.set(privacy: false) == .attach)
    }

    @Test func theInboxKeepsTenFilesPrivatelyAndRefusesOldSystems() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("Documents/Inbox", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let urls = try (1...12).map { index -> URL in
            let url = source.appendingPathComponent("f\(index).txt")
            try Data("\(index)".utf8).write(to: url)
            return url
        }
        let inbox = ShareInbox(dir: root.appendingPathComponent("Library/Caches/shared-inbox"), incomingRoot: source)
        let event = inbox.intake(urls + [URL(string: "https://example.com/x")!], supported: true)
        #expect(event == .files(count: 10, dropped: 3, batch: try #require(inbox.batch)))
        #expect(UUID(uuidString: try #require(inbox.batch)) != nil, "an opaque UUID, nothing of the files")
        #expect(inbox.held.allSatisfy { !$0.path.contains("/Documents/") })
        #expect(inbox.held.first?.lastPathComponent == "f1.txt")
        #expect(urls.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) }, "nothing lingers in Documents/Inbox")
        let taken = inbox.take()
        #expect(taken.count == 10 && inbox.count == 0)
        #expect(FileManager.default.fileExists(atPath: taken[0].path), "the page can still read a delivered file")
        inbox.discard()
        #expect(FileManager.default.fileExists(atPath: taken[0].path), "a discard never deletes files a window owns")
        inbox.remove(taken)
        #expect(!FileManager.default.fileExists(atPath: taken[0].path))

        let late = source.appendingPathComponent("late.txt")
        try Data("x".utf8).write(to: late)
        #expect(inbox.intake([late], supported: false) == .refused(reason: "unsupported_os"))
        #expect(!FileManager.default.fileExists(atPath: late.path) && inbox.count == 0)
        #expect(inbox.intake([URL(string: "https://example.com")!], supported: true) == .refused(reason: "no_files"))
    }
}

/// A vault whose session writes fail as a tampered keychain item would.
private final class FailingVault: SecretVault {
    struct Tampered: Error {}
    let inner = MemoryVault()
    func read(_ path: String) throws -> Data? { try inner.read(path) }
    func write(_ path: String, _ value: Data, _ cls: ProtectionClass) throws {
        if path.hasPrefix("session/") { throw Tampered() }
        try inner.write(path, value, cls)
    }
    func delete(_ path: String) throws { try inner.delete(path) }
    func list(prefix: String) throws -> [String] { try inner.list(prefix: prefix) }
}

final class BrokenKeys: DeviceKeyBackend {
    struct ProviderFailure: Error {}
    func exists(_ alias: String) -> Bool { false }
    func generate(_ alias: String) throws -> SecurityLevel { throw ProviderFailure() }
    func publicPoint(_ alias: String) throws -> Data { throw ProviderFailure() }
    func signDer(_ alias: String, _ data: Data) throws -> Data { throw ProviderFailure() }
    func delete(_ alias: String) {}
}

@Suite struct HandoffStorageFailureTests {
    @Test func anUnlockedKeyFailureIsNotALockedVault() {
        let vault = MemoryVault(), diag = MemoryDiag(), launcher = FakeLauncher()
        let keys = DeviceKeyStore(backend: BrokenKeys(), installs: InstallIdStore(vault: vault), diagnostics: diag)
        let client = HandoffClient(vault: vault, deviceKeys: keys, sessions: SessionStore(vault: vault, diagnostics: diag),
                                   orgs: FakeOrgs(), launcher: launcher, mode: .https(domain: "app.example.com"), deviceLabel: "x",
                                   clock: { 1 }, diagnostics: diag, appLock: nil)
        var outcomes: [SignInOutcome] = []
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes.append($0) }
        #expect(outcomes == [.secureStorageFailed])
        #expect(launcher.launched.isEmpty)
        #expect(Messages.signIn["secure_storage_failed"]?.actions == ["try_again"])
    }

    @Test func aFailedSaveAfterTheBrowserSignInEndsTruthfully() throws {
        let rig = HandoffRig()
        let failing = FailingVault()
        let client = HandoffClient(vault: rig.store.vault, deviceKeys: rig.store.keys,
                                   sessions: SessionStore(vault: failing, diagnostics: rig.store.diag),
                                   orgs: rig.orgs, launcher: rig.launcher, mode: rig.mode, deviceLabel: "x", clock: { rig.now },
                                   diagnostics: rig.store.diag, appLock: nil)
        var outcomes: [SignInOutcome] = []
        client.signIn(orgId: "org-a", request: .machine(host: "laptop-ada.example.com")) { outcomes.append($0) }
        let query = rig.launcher.lastQuery
        let jwe = try Sealer.seal(pk: query["pk"]!, host: "laptop-ada.example.com", state: query["state"]!, payload: [
            "v": 1, "kind": "machine", "host": "laptop-ada.example.com", "jwt": Sealer.jwt(exp: rig.now + 3600), "email": "a@b.c",
            "exp": rig.now + 3600, "iat": rig.now
        ])
        rig.launcher.completions.last!(.redirect(URL(string: "\(rig.base)?state=\(query["state"]!)&jwe=\(jwe)")!))
        #expect(outcomes == [.secureStorageFailed])
        #expect(rig.store.diag.lines.contains { $0.contains("handoff session save failed") })
    }

    @Test func aHostWithADirectSessionIsNotSignedInThroughAnOrg() throws {
        let rig = HandoffRig()
        try rig.store.vault.write("session-direct/laptop-ada.example.com", Data("{}".utf8), .standard)
        rig.start()
        #expect(rig.outcomes == [.refused(code: "direct_host")])
        #expect(rig.launcher.launched.isEmpty)
    }
}

final class DirectStub: URLProtocol {
    // swiftlint:disable:next large_tuple
    nonisolated(unsafe) static var replies: [(Int, [String: String], Data)] = []
    nonisolated(unsafe) static var seen: [URLRequest] = []
    /// Runs while a request is on the wire: what another sign-in could do during that await.
    nonisolated(unsafe) static var onRequest: ((URLRequest) -> Void)?
    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        Self.seen.append(request)
        Self.onRequest?(request)
        guard !Self.replies.isEmpty else { return client!.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)) }
        let (status, headers, data) = Self.replies.removeFirst()
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

@Suite(.serialized) struct DirectAuthTests {
    let auth = DirectAuth(session: OrgApiClient.makeSession(protocolClasses: [DirectStub.self]), userAgent: "YaranApp/1.0.0 (ios; phone)", diagnostics: nil)
    let json = ["Content-Type": "application/json"]

    // The tuple is DirectStub.replies' element shape.
    // swiftlint:disable:next large_tuple
    func status(_ instance: String, signedIn: Bool = false) -> (Int, [String: String], Data) {
        (200, json, Data("""
        {"password_set":true,"required_here":true,"signed_in":\(signedIn),"transport_encrypted":true,"instance":"\(instance)","native_auth_ui":true}
        """.utf8))
    }

    @Test func theSessionGoesOnlyToItsOwnInstanceAndRedirectsAreNotFollowed() async {
        DirectStub.seen = []
        let stored = DirectSession(host: "yaran.example.com", token: "tok_1", cookieName: "yaran_session_443", instance: "i1", issuedAt: 1)
        DirectStub.replies = [status("i1"), status("i1", signedIn: true)]
        let signed = await auth.status(host: "yaran.example.com", stored: stored)
        #expect(signed == .yaran(instance: "i1", passwordSet: true, requiredHere: true, signedIn: true, transportEncrypted: true))
        #expect(DirectStub.seen.map { $0.value(forHTTPHeaderField: "Cookie") } == [nil, "yaran_session_443=tok_1"])

        DirectStub.seen = []
        DirectStub.replies = [status("someone-else")]
        _ = await auth.status(host: "yaran.example.com", stored: stored)
        #expect(DirectStub.seen.count == 1 && DirectStub.seen[0].value(forHTTPHeaderField: "Cookie") == nil)

        DirectStub.seen = []
        DirectStub.replies = [(302, ["Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login/x"], Data()), status("i1")]
        #expect(await auth.status(host: "yaran.example.com", stored: nil) == .accessRequired)
        #expect(DirectStub.seen.count == 1)
        DirectStub.replies = []
        #expect(await auth.status(host: "10.0.0.1", stored: stored) == .refused(reason: "invalid_host"))
    }

    @Test func anOrgRouteCarriesOnlyItsOwnOrgSession() async throws {
        let vault = MemoryVault()
        let sessions = SessionStore(vault: vault, diagnostics: nil)
        DirectStub.seen = []
        #expect(try await auth.orgRouteStatus(orgId: "https://cp.example.com", host: "a.example.com", sessions: sessions, now: 10) == nil)
        try sessions.put(orgId: "https://other.example.com", payload: payload(host: "a.example.com", exp: 9_999_999_999), kind: .accessJwt)
        #expect(try await auth.orgRouteStatus(orgId: "https://cp.example.com", host: "a.example.com", sessions: sessions, now: 10) == nil)
        #expect(DirectStub.seen.isEmpty)
        try sessions.put(orgId: "https://cp.example.com", payload: payload(host: "a.example.com", exp: 9_999_999_999), kind: .accessJwt)
        DirectStub.replies = [status("i1")]
        let got = try await auth.orgRouteStatus(orgId: "https://cp.example.com", host: "a.example.com", sessions: sessions, now: 10)
        #expect(got?.kind == "yaran")
        #expect(DirectStub.seen.last?.value(forHTTPHeaderField: "Cookie")?.hasPrefix("CF_Authorization=") == true)
        DirectStub.replies = [(302, ["Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login/x"], Data())]
        #expect(try await auth.orgRouteStatus(orgId: "https://cp.example.com", host: "a.example.com", sessions: sessions, now: 10) == nil)
    }

    @Test func aTokenThePhoneCannotKeepIsRevoked() async {
        DirectStub.seen = []
        DirectStub.replies = [(200, json, Data(#"{"token":"tok_old","expires_at":null}"#.utf8)), (204, [:], Data())]
        var password = Array("pw".utf8)
        let answer = await auth.login(host: "yaran.example.com", body: DirectWire.loginBody(password: &password, label: "l"))
        #expect(answer == .failed(.serverRefused(status: 200, code: "cookie_name_missing", message: ""), revoke: "tok_old"))
        #expect(DirectStub.seen.map(\.url!.path) == ["/api/v1/auth/cli-login", "/api/v1/auth/cli-logout"])
        #expect(DirectStub.seen.last?.value(forHTTPHeaderField: "Authorization") == "Bearer tok_old")
    }
}
