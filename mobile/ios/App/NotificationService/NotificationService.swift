/// The Notification Service Extension: rewrites the relay's generic alert into the decrypted,
/// localized notification on the device (D11).
///
/// Every decision is `PushInbox.alertOutcome` from YaranPushCore, which the Swift tests drive
/// with fixture payloads; this file only moves values between UserNotifications and it.
///
/// - Loads no Capacitor and no third-party code (memory: the NSE limit is about 24 MB per an
///   Apple engineer on the forums, not the docs).
/// - On any failure, and in `serviceExtensionTimeWillExpire`, the relay's generic alert stays.
/// - Not compiled here: the target joins Phase 14's Xcode project.
///
/// <module-headers:begin>
/// Uses:
/// NotificationService/NotificationService
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// └── YaranPushCore/SharedPushState (inferred)
/// External: UserNotifications
///
/// Used by: entry point (NSExtensionPrincipalClass of the Notification Service Extension target (its Info.plist))
/// <module-headers:end>
import UserNotifications
import YaranPushCore

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        original = request.content
        let appGroup = Bundle.main.object(forInfoDictionaryKey: "YaranAppGroup") as? String ?? ""
        guard let state = SharedPushState(appGroup: appGroup) else { return finish(request.content) }
        let inbox = PushInbox(subscriptions: PushSubscriptionStore(backend: SystemKeychain(accessGroup: appGroup)), state: state)
        switch inbox.alertOutcome(userInfo: request.content.userInfo, now: Date()) {
        case .keepGeneric:
            finish(request.content)
        case let .show(content):
            guard let mutable = request.content.mutableCopy() as? UNMutableNotificationContent else { return finish(request.content) }
            content.apply(to: mutable)
            finish(mutable)
        case .suppress:
            finish(UNNotificationContent())
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let original { finish(original) }
    }

    private func finish(_ content: UNNotificationContent) {
        contentHandler?(content)
        contentHandler = nil
    }
}
