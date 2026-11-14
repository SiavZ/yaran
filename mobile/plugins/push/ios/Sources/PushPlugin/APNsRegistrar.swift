/// APNs authorization and device token for the iOS push plugin.
///
/// Asks for `.alert, .sound, .badge` only when the shell's explicit "Turn on notifications"
/// step calls it, registers for remote notifications and waits for the token Capacitor's app
/// delegate forwards (`.capacitorDidRegisterForRemoteNotifications`). A token that differs
/// from the last one seen fires `onTokenChange`, and the shell re-registers every org.
///
/// - The token is hex, lowercase (02 `ApnsMintRequest.apns_token`); it is not a secret but
///   still never goes to JS.
/// - Not compiled here (UIKit and Capacitor).
///
/// <module-headers:begin>
/// Uses: none
/// External: Capacitor, Foundation, UIKit, UserNotifications
///
/// Used by:
/// PushPlugin/APNsRegistrar
/// └── PushPlugin/PushPlugin (inferred)
/// <module-headers:end>
import Capacitor
import Foundation
import UIKit
import UserNotifications

final class APNsRegistrar {
    var onTokenChange: (() -> Void)?
    private var waiters: [CheckedContinuation<String?, Never>] = []
    private let lastTokenKey = "yaran.push.apnsToken"

    init() {
        let center = NotificationCenter.default
        center.addObserver(forName: .capacitorDidRegisterForRemoteNotifications, object: nil, queue: .main) { [weak self] note in
            guard let data = note.object as? Data else { return }
            self?.deliver(data.map { String(format: "%02x", $0) }.joined())
        }
        center.addObserver(forName: .capacitorDidFailToRegisterForRemoteNotifications, object: nil, queue: .main) { [weak self] _ in
            self?.deliver(nil)
        }
    }

    func permissionState() async -> String {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: "granted"
        case .denied: "denied"
        case .notDetermined: "prompt"
        @unknown default: "prompt"
        }
    }

    func requestPermission() async -> String {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        return await permissionState()
    }

    /// The current APNs token, or nil without permission or when registration fails.
    @MainActor
    func token() async -> String? {
        guard await permissionState() == "granted" else { return nil }
        return await withCheckedContinuation { continuation in
            waiters.append(continuation)
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func deliver(_ token: String?) {
        if let token {
            let defaults = UserDefaults.standard
            if let last = defaults.string(forKey: lastTokenKey), last != token { onTokenChange?() }
            defaults.set(token, forKey: lastTokenKey)
        }
        let pending = waiters
        waiters.removeAll()
        pending.forEach { $0.resume(returning: token) }
    }
}
