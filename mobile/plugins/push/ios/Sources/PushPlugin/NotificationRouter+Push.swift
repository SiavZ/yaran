/// Tap, foreground presentation and the background cleared-event handler for the iOS plugin.
///
/// The plugin registers with Capacitor's `NotificationRouter` as its push handler instead of
/// replacing the `UNUserNotificationCenter` delegate, so it cannot fight other plugins (the
/// router API type-checks against Capacitor 8.6.2; runtime delivery is still unverified on a device).
/// `didReceive` emits `notificationTapped` with ids only, retained until JS consumes it.
///
/// - `handleBackgroundPush` is called from the app delegate's
///   `didReceiveRemoteNotification`: it decrypts a cleared event with the shared core and
///   removes the matching deliveries (best effort; iOS throttles background pushes).
/// - Type-checked against Mac Catalyst by typecheck-catalyst.sh, not built for iOS.
///
/// <module-headers:begin>
/// Uses:
/// PushPlugin/NotificationRouter+Push
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// └── YaranPushRegistration/PresentationPolicy (inferred)
/// External: Capacitor, Foundation, UIKit, UserNotifications
///
/// Used by: entry point (extension of PushPlugin: Capacitor's NotificationRouter calls it, and the app delegate calls handleBackgroundPush)
/// <module-headers:end>
import Capacitor
import Foundation
import UIKit
import UserNotifications
import YaranPushCore
import YaranPushRegistration

extension PushPlugin: NotificationHandlerProtocol {
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        PresentationPolicy.foregroundOptions(userInfo: notification.request.content.userInfo, visible: visible)
    }

    public func didReceive(response: UNNotificationResponse) {
        guard let tap = TapEvent(userInfo: response.notification.request.content.userInfo, actionIdentifier: response.actionIdentifier) else {
            return
        }
        notifyListeners("notificationTapped", data: tap.dictionary, retainUntilConsumed: true)
    }

    /// The app delegate's background-push entry point (cleared events).
    public static func handleBackgroundPush(userInfo: [AnyHashable: Any], completion: @escaping (UIBackgroundFetchResult) -> Void) {
        let config = PushConfig(bundle: .main)
        guard let state = SharedPushState(appGroup: config.appGroup) else { return completion(.noData) }
        let inbox = PushInbox(subscriptions: PushSubscriptionStore(backend: SystemKeychain(accessGroup: config.appGroup)), state: state)
        guard let filter = inbox.clearFilter(userInfo: userInfo) else { return completion(.noData) }
        removeDelivered(filter) { completion(.newData) }
    }
}
