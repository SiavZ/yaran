/// When the machine window may open or resume around App Lock: never while it is engaged.
///
/// The window opens once and resumes after every return from the background; either one that
/// arrives while locked waits and runs exactly once at the unlock, whichever of the unlock
/// notification and the app becoming active comes first. Opening, session renewal and the
/// sign-in browser therefore never start behind the lock cover.
///
/// - Pure; `MachineViewController` feeds it UIKit's events and the lock's current state.
///
/// <module-headers:begin>
/// Uses: none
/// External: none
///
/// Used by:
/// MachineViewCore/LockGate
/// ├── MachineView/MachineViewController (inferred)
/// └── MachineViewCoreTests/LockTests (inferred)
/// <module-headers:end>

public struct LockGate: Equatable {
    public enum Step: Equatable { case none, open, resume }

    private var due = Step.none
    private var opened = false

    public init() {}

    /// The window appeared for the first time.
    public mutating func appeared(locked: Bool) -> Step {
        due = .open
        return proceed(locked)
    }

    /// The app went to the background: the next unlocked activation resumes.
    public mutating func enteredBackground() {
        if opened { due = .resume }
    }

    public mutating func becameActive(locked: Bool) -> Step { proceed(locked) }

    /// App Lock changed; engaging over an open page also resumes once it is unlocked.
    public mutating func lockChanged(locked: Bool) -> Step {
        if locked, opened, due == .none { due = .resume }
        return proceed(locked)
    }

    private mutating func proceed(_ locked: Bool) -> Step {
        guard !locked else { return .none }
        let step = due
        due = .none
        if step == .open { opened = true }
        return step
    }
}
