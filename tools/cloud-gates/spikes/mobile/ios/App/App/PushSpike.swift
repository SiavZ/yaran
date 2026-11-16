/// PushSpike: the G4 iOS probe that obtains an APNs device token for the apns-probe Worker.
///
/// Requests notification permission, registers for remote notifications, and shows the
/// device token as hex in the shell's debug screen for copying into `g04-apns.sh`. It also
/// presents notifications while the app is in the foreground, so a G4 send is visible either way.
///
/// - The token reaches this plugin through Capacitor's `capacitorDidRegisterForRemoteNotifications`
///   notification, which AppDelegate posts; the token value is shown on screen, not logged.
/// - Requires the `aps-environment` entitlement (App.entitlements) and a signing team.
///
/// <module-headers:begin>
/// Uses:
/// App/PushSpike
/// └── App/MachineViewSpike (inferred)  (gateLog)
/// External: Capacitor, UIKit, UserNotifications
///
/// Used by:
/// App/PushSpike
/// └── App/GateSpikeViewController (inferred)
/// <module-headers:end>
import Capacitor
import UIKit
import UserNotifications

@objc(PushSpike)
public class PushSpike: CAPPlugin, CAPBridgedPlugin, UNUserNotificationCenterDelegate {
    public let identifier = "PushSpike"
    public let jsName = "PushSpike"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "register", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didRegister(_:)),
                           name: .capacitorDidRegisterForRemoteNotifications, object: nil)
        center.addObserver(self, selector: #selector(didFail(_:)),
                           name: .capacitorDidFailToRegisterForRemoteNotifications, object: nil)
        UNUserNotificationCenter.current().delegate = self
    }

    @objc func register(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            gateLog.info("push permission granted=\(granted, privacy: .public)")
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            var result: [String: Any] = ["started": true, "permission": granted]
            if let error { result["permissionError"] = error.localizedDescription }
            call.resolve(result)
        }
    }

    @objc private func didRegister(_ note: Notification) {
        guard let token = note.object as? Data else { return }
        gateLog.info("push APNs token received (\(token.count, privacy: .public) bytes)")
        let hex = token.map { String(format: "%02x", $0) }.joined()
        notifyListeners("push", data: ["kind": "token", "token": hex], retainUntilConsumed: true)
    }

    @objc private func didFail(_ note: Notification) {
        let reason = (note.object as? Error)?.localizedDescription ?? "unknown error"
        gateLog.error("push registration failed: \(reason, privacy: .public)")
        notifyListeners("push", data: ["kind": "failed", "reason": reason], retainUntilConsumed: true)
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        gateLog.info("push received in foreground")
        notifyListeners("push", data: ["kind": "message", "title": notification.request.content.title])
        completionHandler([.banner, .list, .sound])
    }
}
