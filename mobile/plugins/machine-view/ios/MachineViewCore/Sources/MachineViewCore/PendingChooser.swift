/// One page file chooser waiting on the shared-files confirm or the Files picker (G5; Sol native
/// review round 7).
///
/// The page that asked owns the answer, and only while its window still shows it: the files are
/// the ones held when the confirm opened, never the list as it is when a button is tapped. A route
/// switch or close cancels it, answering the old page's chooser with nothing, once, and leaving
/// the held files for the next page; a button or picker ending that arrives after that changes nothing.
///
/// - Main actor, like the window.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation
///
/// Used by:
/// MachineViewCore/PendingChooser
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineView/MachineViewController+Direct (inferred)
/// ├── MachineViewCoreTests/AdmissionTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// └── MachineViewCoreTests/PasswordSheetTests (inferred)
/// <module-headers:end>
import Foundation

@MainActor
public final class PendingChooser {
    public let held: [URL]
    private let owned: () -> Bool
    private var answer: (([URL]?) -> Void)?

    public init(held: [URL], owned: @escaping () -> Bool, answer: @escaping ([URL]?) -> Void) {
        (self.held, self.owned, self.answer) = (held, owned, answer)
    }

    public var settled: Bool { answer == nil }

    /// Answers with `files` (nil for none) while the page still owns the chooser, else with nothing.
    /// True only when files really went to the page that asked; once.
    @discardableResult
    public func settle(_ files: [URL]?) -> Bool {
        guard let answer else { return false }
        self.answer = nil
        let delivered = owned() ? files : nil
        answer(delivered)
        return delivered != nil
    }

    /// The page is going: its chooser gets nothing, once.
    public func cancel() { settle(nil) }
}

/// The native password sheet of one route's sign-in (G1; Sol native review round 11): answered once,
/// by the user's own buttons, or with nothing when the route or window it belongs to goes. Its
/// cancel dismisses only that one sheet, never another alert the app or a newer route shows.
@MainActor
public final class PendingSheet {
    private var answer: (([UInt8]?) -> Void)?
    private let dismiss: () -> Void

    public init(dismiss: @escaping () -> Void, answer: @escaping ([UInt8]?) -> Void) {
        (self.dismiss, self.answer) = (dismiss, answer)
    }

    public var settled: Bool { answer == nil }

    /// The user's own Sign in or Cancel (the alert is already going): answered once.
    public func respond(_ password: [UInt8]?) {
        guard let answer else { return }
        self.answer = nil
        answer(password)
    }

    /// The route or window it belongs to is going: the sheet goes and is answered with nothing, once.
    public func cancel() {
        guard let answer else { return }
        self.answer = nil
        dismiss()
        answer(nil)
    }
}

/// What a machine window is waiting on the user for: the page's file chooser and the route's
/// password sheet. Both belong to the route on screen, and go with it.
@MainActor
public final class OpenPrompts {
    public var chooser: PendingChooser?
    public var sheet: PendingSheet?
    /// The password attempt under way (preflight, sheet, POST), by token; one at a time.
    private var signing: Int?
    private var attempts = 0

    public init() {}

    /// A token for a new password attempt, or nil while one is under way.
    public func reserveSignIn() -> Int? {
        guard signing == nil else { return nil }
        attempts += 1
        signing = attempts
        return attempts
    }

    /// Ends attempt `token`, exactly once; one a route change or close already ended frees nothing newer.
    public func releaseSignIn(_ token: Int) {
        if signing == token { signing = nil }
    }

    /// The route or window is going: each pending prompt is answered with nothing, once.
    /// True when a chooser was pending (its confirm or picker is then dismissed by the caller).
    @discardableResult
    public func settleAll() -> Bool {
        signing = nil // the attempt goes with its route; the next route's may start
        sheet?.cancel()
        sheet = nil
        guard let pending = chooser else { return false }
        chooser = nil
        pending.cancel()
        return true
    }
}
