/// The one machine window the plugin shows, and the one open waiting to replace it (Sol native
/// review round 11).
///
/// Opening over a window asks that window to close and presents the new one only from that
/// window's own dismissal completion (`dismissed`), never after a guessed delay. A newer open
/// replaces a waiting one, and a close cancels it; a waiting open that never shows (superseded,
/// cancelled, or with nothing to present on) releases exactly the shared files it claimed, never
/// a share held since. Generic over the window so the ordering is testable without UIKit.
///
/// - Main actor, like the plugin.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/WindowSlot
/// ├── MachineView/MachineViewPlugin (inferred)
/// └── MachineViewCoreTests/WindowSlotTests (inferred)
/// <module-headers:end>
import Foundation

@MainActor
public final class WindowSlot<Window: AnyObject> {
    private struct Waiting {
        let files: [URL]
        let present: () -> Window?
    }

    public private(set) weak var current: Window?
    private var waiting: Waiting?
    private let close: (Window) -> Void
    private let release: ([URL]) -> Void

    /// `close` asks a window to close (its dismissal ends in `dismissed`); `release` deletes claimed files.
    public init(close: @escaping (Window) -> Void, release: @escaping ([URL]) -> Void) {
        (self.close, self.release) = (close, release)
    }

    public var hasWaiting: Bool { waiting != nil }

    /// Shows a window now, or once the current one has been dismissed. `present` returns nil when
    /// there is nothing to present on; `files` are the shared files this open claimed.
    public func open(files: [URL], present: @escaping () -> Window?) {
        if let superseded = waiting { release(superseded.files) }
        guard let shown = current else {
            waiting = nil
            return show(Waiting(files: files, present: present))
        }
        let wasWaiting = waiting != nil
        waiting = Waiting(files: files, present: present)
        if !wasWaiting { close(shown) }
    }

    /// A window finished its dismissal; the open waiting for it, if any, shows now.
    public func dismissed(_ window: Window) {
        guard window === current else { return }
        current = nil
        guard let next = waiting else { return }
        waiting = nil
        show(next)
    }

    /// The JS close: the current window closes and a waiting open never shows.
    public func closeAll() {
        if let cancelled = waiting { release(cancelled.files) }
        waiting = nil
        if let shown = current { close(shown) }
    }

    private func show(_ open: Waiting) {
        guard let window = open.present() else { return release(open.files) }
        current = window
    }
}
