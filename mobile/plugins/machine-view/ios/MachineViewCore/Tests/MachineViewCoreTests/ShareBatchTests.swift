/// ShareBatchTests: a press acts on the share it was made for (G5; share-batch contract).
///
/// `ShareCommand` is what the plugin's `open({shareBatch})` and `discardShare({batch})` run on the
/// main thread, over a real `ShareInbox` on disk. Share A is shown and its batch captured, share B
/// arrives before the queued command runs (Capacitor hops to main after the press), and A's Send or
/// Discard is refused `share_changed` with B and its pending event untouched. Controls: the current
/// batch, nothing held, malformed ids. The Capacitor plugin itself cannot run under `swift test`;
/// its delegation to these commands is pinned by reading its source.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/ShareBatchTests
/// ├── MachineViewCore/ShareInbox (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
struct ShareBatchTests {
    private func inbox() throws -> (ShareInbox, (String) throws -> URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let source = root.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let file = { (name: String) -> URL in
            let url = source.appendingPathComponent(name)
            try Data(name.utf8).write(to: url)
            return url
        }
        return (ShareInbox(dir: root.appendingPathComponent("inbox"), incomingRoot: root.appendingPathComponent("Documents/Inbox")), file, root)
    }

    private func batch(_ event: ShareEvent) throws -> String {
        guard case let .files(_, _, id) = event else { throw ShareCommand.Failure.noShare }
        return id
    }

    @Test func aPressForShareANeverTakesShareB() throws {
        let (inbox, file, root) = try inbox()
        defer { try? FileManager.default.removeItem(at: root) }
        let a = try batch(inbox.intake([try file("a1")], supported: true))
        let eventB = inbox.intake([try file("b1"), try file("b2")], supported: true) // lands before A's queued Send
        let b = try batch(eventB)
        #expect(a != b)
        #expect(ShareCommand.open(inbox, batch: a) == .failure(.shareChanged))
        #expect(inbox.count == 2 && inbox.batch == b && inbox.held.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
        guard case let .success(files) = ShareCommand.open(inbox, batch: b) else { Issue.record("B is held"); return }
        #expect(files.map(\.lastPathComponent) == ["b1", "b2"] && inbox.count == 0 && inbox.batch == nil)
        #expect(ShareCommand.open(inbox, batch: b) == .failure(.noShare))
    }

    @Test func aDiscardForShareALeavesShareBAndItsEvent() throws {
        let (inbox, file, root) = try inbox()
        defer { try? FileManager.default.removeItem(at: root) }
        let a = try batch(inbox.intake([try file("a1")], supported: true))
        var waiting: ShareEvent? = inbox.intake([try file("b1")], supported: true) // B not told yet (the lock is up)
        let b = try batch(waiting!)
        #expect(ShareCommand.discard(inbox, batch: a, waiting: &waiting) == .shareChanged)
        #expect(inbox.count == 1 && inbox.batch == b && waiting?.tells(b) == true, "B and its event stay")
        let held = inbox.held
        #expect(ShareCommand.discard(inbox, batch: b, waiting: &waiting) == nil)
        #expect(inbox.count == 0 && waiting == nil && held.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
        #expect(ShareCommand.discard(inbox, batch: b, waiting: &waiting) == nil, "nothing held: done")
    }

    @Test func malformedIdsAreRefusedAndChangeNothing() throws {
        let (inbox, file, root) = try inbox()
        defer { try? FileManager.default.removeItem(at: root) }
        var waiting: ShareEvent? = inbox.intake([try file("a1")], supported: true)
        for bad in ["", "a1", "../x", "8d1c9a7e-3b0f-4b8e-9a51-2f6c0d4e7b13x", "8D1C9A7E3B0F4B8E9A512F6C0D4E7B13"] {
            #expect(ShareCommand.open(inbox, batch: bad) == .failure(.invalidArguments), "\(bad)")
            #expect(ShareCommand.discard(inbox, batch: bad, waiting: &waiting) == .invalidArguments, "\(bad)")
        }
        #expect(ShareCommand.discard(inbox, batch: nil, waiting: &waiting) == .invalidArguments)
        #expect(inbox.count == 1 && waiting != nil)
    }

    /// Round 10: a cold start from "Open in yaran" never hands a file URL to JS. Capacitor's own scene
    /// proxy replays the launch's URL contexts to `App.getLaunchUrl` (its `lastURL`) and `appUrlOpen`
    /// (its openURL notification), so the app never gives it the connection options; `ShareIntake.connect`
    /// replays links and user activities through the proxy's public methods and keeps files native,
    /// as the warm path does. Pinned by reading the sources (the scene path needs a UIKit host and
    /// Capacitor's bridge, so it is type-checked against them, not run here).
    @Test func aColdStartNeverHandsAFileURLToJS() throws {
        let root = Fixtures.pluginRoot
        let scene = try String(contentsOf: root.appendingPathComponent("../../ios/App/App/SceneDelegate.swift"), encoding: .utf8)
        let plugin = try String(contentsOf: root.appendingPathComponent("ios/Sources/MachineView/MachineViewPlugin.swift"), encoding: .utf8)
        let proxy = try String(contentsOf: root.appendingPathComponent(
            "../../app/node_modules/@capacitor/ios/Capacitor/Capacitor/CAPSceneDelegateProxy.swift"), encoding: .utf8)
        #expect(proxy.contains("self.scene(scene, openURLContexts: connectionOptions.urlContexts)"), "what the proxy would replay, unfiltered")
        #expect(proxy.contains("lastURL = context.url") && proxy.contains("capacitorOpenURL"), "into both JS channels")
        #expect(!scene.contains("willConnectTo: session, options: connectionOptions)"), "the options never reach the proxy")
        #expect(scene.contains("ShareIntake.connect(scene, options: connectionOptions)"))
        #expect(scene.contains("let links = URLContexts.subtracting(files)"), "the warm path forwards links only")
        for wiring in ["let links = contexts.filter { !$0.url.isFileURL }", "receive(contexts.subtracting(links).map(\\.url))",
                       "SceneDelegateProxy.shared.scene(scene, openURLContexts: links)",
                       "SceneDelegateProxy.shared.scene(scene, continue: activity)", "post(name: .capacitorSceneWillConnect, object: scene)"] {
            #expect(plugin.contains(wiring), "\(wiring)")
        }
    }

    /// The Capacitor plugin delegates to these commands (type-checked, not run here).
    @Test func thePluginActsOnlyThroughTheNamedBatch() throws {
        let plugin = try String(contentsOf: Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView/MachineViewPlugin.swift"),
                                encoding: .utf8)
        for wiring in ["ShareCommand.open(AppServices.shared.shareInbox, batch: shareBatch)",
                       "ShareCommand.discard(AppServices.shared.shareInbox, batch: batch, waiting: &ShareIntake.waiting)",
                       "\"batch\": batch]", "call.options[\"share\"] != nil"] {
            #expect(plugin.contains(wiring), "\(wiring)")
        }
        #expect(!plugin.contains("shareInbox.take()") && !plugin.contains("shareInbox.discard()"), "no unconditional take or discard")
    }
}
