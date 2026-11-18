/// Whether the machine page may be in the window, given the covers that can obscure it.
///
/// WebKit counts a page visible while its view is in a window and the app is not in the
/// background, so a page under a cover keeps sending the viewed beat that holds back attention
/// and pushes for its tab (G4) unless the `WKWebView` is taken out of the window. Two covers
/// obscure it: the App Lock cover and the screen-privacy cover (screen capture, app switcher).
/// The page comes back only when no cover is up: lifting one of them while the other stays
/// leaves it out.
///
/// - Pure; the controller applies each `Change` to the real view.
///
/// <module-headers:begin>
/// Uses: none
/// External: none
///
/// Used by:
/// MachineViewCore/CoverState
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Covers (inferred)
/// └── MachineViewCoreTests/DirectTests (inferred)
/// <module-headers:end>
public struct CoverState: Equatable {
    public enum Change: Equatable { case detach, attach, none }

    public private(set) var lock = false
    public private(set) var privacy = false

    public init() {}

    /// The page belongs in the window only while nothing covers it.
    public var pageAttached: Bool { !lock && !privacy }

    /// Records a cover's new state and says what the view must do about it.
    public mutating func set(lock: Bool? = nil, privacy: Bool? = nil) -> Change {
        let before = pageAttached
        if let lock { self.lock = lock }
        if let privacy { self.privacy = privacy }
        if before == pageAttached { return .none }
        return pageAttached ? .attach : .detach
    }
}
