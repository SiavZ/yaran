/// Wall-clock one-shot timers for the machine window's renewal schedule.
///
/// Split from `MachineViewController.swift`; `RenewalCoordinator` schedules through it.
///
/// - Main actor. Not compiled on this machine (UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MainScheduler
/// └── MachineViewCore/RenewalCoordinator (inferred)
/// External: Foundation
///
/// Used by:
/// MachineView/MainScheduler
/// └── MachineView/MachineViewController (inferred)
/// <module-headers:end>
import Foundation
import MachineViewCore

/// Wall-clock one-shot timers; a timer that slept through the background is re-checked on resume.
@MainActor
final class MainScheduler: @preconcurrency OneShotScheduler {
    final class Token: Cancellable {
        var timer: Timer?
        func cancel() { timer?.invalidate() }
    }

    func schedule(at second: Int64, _ fire: @escaping () -> Void) -> Cancellable {
        let token = Token()
        let delay = max(0, Double(second) - Date().timeIntervalSince1970)
        token.timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in
            MainActor.assumeIsolated { fire() }
        }
        return token
    }
}
