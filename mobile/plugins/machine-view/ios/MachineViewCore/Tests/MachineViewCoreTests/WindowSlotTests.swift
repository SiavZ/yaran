/// WindowSlotTests: which machine window shows, and when (Sol native review round 11). Fake windows
/// stand in for `MachineViewController`; the plugin's use of the slot is pinned by reading its
/// source and type-checked against UIKit, not run here.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/WindowSlotTests
/// ├── MachineViewCore/WindowSlot (inferred)
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>

import Foundation
import Testing
@testable import MachineViewCore

@MainActor
private final class Rig {
    final class Window { let name: String; init(_ name: String) { self.name = name } }
    var closed: [String] = []
    var released: [[URL]] = []
    var shown: [String] = []
    var presenter = true
    lazy var slot = WindowSlot<Window>(close: { [unowned self] in self.closed.append($0.name) },
                                       release: { [unowned self] in self.released.append($0) })

    func open(_ name: String, files: [URL] = []) {
        slot.open(files: files) { [unowned self] in
            guard self.presenter else { return nil }
            self.shown.append(name)
            let window = Window(name)
            self.alive.append(window) // what UIKit's presentation does for a controller
            return window
        }
    }

    var alive: [Window] = []
    func current() -> Window? { slot.current }
}

@MainActor
struct WindowSlotTests {
    private let a1 = URL(fileURLWithPath: "/tmp/inbox/A/0/a1")

    // open A while an old window shows, then close: A never appears, and its claimed file goes.
    @Test func aCloseCancelsTheOpenWaitingForTheOldWindow() throws {
        let rig = Rig()
        rig.open("old")
        let old = try #require(rig.current())
        rig.open("A", files: [a1])
        #expect(rig.closed == ["old"] && rig.shown == ["old"], "A waits for old's dismissal")
        rig.slot.closeAll()
        #expect(rig.released == [[a1]])
        rig.slot.dismissed(old)
        #expect(rig.shown == ["old"] && rig.slot.current == nil, "A never opens after the close")
    }

    // Two opens overlap while the old window dismisses: only the newest shows, the first releases its files.
    @Test func aNewerOpenReplacesTheWaitingOne() throws {
        let rig = Rig()
        rig.open("old")
        let old = try #require(rig.current())
        rig.open("A", files: [a1])
        rig.open("B")
        #expect(rig.closed == ["old"], "the old window is asked once")
        #expect(rig.released == [[a1]], "A's claimed file goes, nothing else")
        rig.slot.dismissed(old)
        #expect(rig.shown == ["old", "B"] && rig.current()?.name == "B")
    }

    // Only the current window's dismissal shows what waits; a stale one changes nothing.
    @Test func onlyTheCurrentWindowsDismissalShowsTheNext() throws {
        let rig = Rig()
        rig.open("old")
        let old = try #require(rig.current())
        rig.open("A")
        rig.slot.dismissed(Rig.Window("stranger"))
        #expect(rig.shown == ["old"] && rig.slot.hasWaiting)
        rig.slot.dismissed(old)
        #expect(rig.shown == ["old", "A"])
    }

    // Nothing to present on: the claimed files are released, not leaked.
    @Test func anOpenWithNothingToPresentOnReleasesItsFiles() {
        let rig = Rig()
        rig.presenter = false
        rig.open("A", files: [a1])
        #expect(rig.released == [[a1]] && rig.slot.current == nil)
    }

    @Test func anOpenWithNoWindowShowsAtOnce() {
        let rig = Rig()
        rig.open("A")
        #expect(rig.shown == ["A"] && rig.closed.isEmpty)
    }

    /// The plugin presents through the slot, from the controller's own dismissal (type-checked, not run here).
    @Test func thePluginPresentsOnlyThroughTheSlot() throws {
        let plugin = try String(contentsOf: Fixtures.pluginRoot.appendingPathComponent("ios/Sources/MachineView/MachineViewPlugin.swift"),
                                encoding: .utf8)
        #expect(!plugin.contains("asyncAfter"), "no guessed dismissal delay")
        for wiring in ["slot.open(files: target.shared)", "slot.dismissed(", "self.slot.closeAll()", "AppServices.shared.shareInbox.remove($0)"] {
            #expect(plugin.contains(wiring), "\(wiring)")
        }
    }
}
