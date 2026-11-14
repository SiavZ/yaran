/// `Push` Capacitor plugin, iOS: the bridge between the shell's push orchestration and the
/// native registration, subscription store and presentation code.
///
/// Validates arguments, calls `DeviceRegistrar` and the stores, and returns only non-secret
/// facts: a `Device` (which never carries the endpoint), a reason, or the local state's host and
/// key ids. Taps arrive through `NotificationRouter+Push.swift` and are retained until JS
/// listens, so a cold-start tap is not lost.
///
/// - D22: no JWT, endpoint, key or auth secret crosses the bridge in either direction.
/// - Bindings: the app sets `PushPlugin.orgApi` at launch to an adapter over Phase 15's
///   `OrgApiClient`/`DeviceKeyStore`; Info.plist carries `YaranAppGroup`, `YaranRelayURL`,
///   `YaranFlavor` and `YaranApnsEnvironment` from the publisher build config (Phase 14).
/// - Not compiled here (needs Capacitor and Xcode); its logic lives in YaranPushRegistration.
///
/// <module-headers:begin>
/// Uses:
/// PushPlugin/PushPlugin
/// ├── PushPlugin/APNsRegistrar (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// ├── YaranPushRegistration/OrgApiGateway (inferred)
/// ├── YaranPushRegistration/PresentationPolicy (inferred)
/// └── YaranPushRegistration/RelayEndpointClient (inferred)
/// External: Capacitor, Foundation, UIKit, UserNotifications
///
/// Used by: entry point (Capacitor plugin class, registered by CAPBridgedPlugin under jsName Push)
/// PushPlugin/PushPlugin
/// └── PushPlugin/NotificationRouter+Push (inferred)
/// <module-headers:end>
import Capacitor
import Foundation
import UIKit
import UserNotifications
import YaranPushCore
import YaranPushRegistration

@objc(PushPlugin)
public class PushPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PushPlugin"
    public let jsName = "Push"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDistributors", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectDistributor", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerDevice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "localState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forgetOrg", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLocalMutes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cacheMachineNames", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVisibleAgent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDelivered", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "drainPendingRegistrations", returnType: CAPPluginReturnPromise),
    ]

    /// Set by the app at launch: the adapter over Phase 15's native org client.
    public static var orgApi: OrgApiGateway?

    let apns = APNsRegistrar()
    var visible: VisibleAgent?
    lazy var config = PushConfig(bundle: .main)
    lazy var store = PushSubscriptionStore(backend: SystemKeychain(accessGroup: config.appGroup))
    lazy var state = SharedPushState(appGroup: config.appGroup) ?? SharedPushState(defaults: .standard)

    override public func load() {
        bridge?.notificationRouter.pushNotificationHandler = self
        UNUserNotificationCenter.current().setNotificationCategories(
            PresentationPolicy.categories(muteTitle: NSLocalizedString("PUSH_ACTION_MUTE_MACHINE", value: "Mute this machine", comment: ""))
        )
        apns.onTokenChange = { [weak self] in self?.notifyListeners("endpointChanged", data: ["orgId": NSNull()]) }
    }

    @objc func checkPermission(_ call: CAPPluginCall) {
        Task { call.resolve(["notifications": await apns.permissionState()]) }
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        Task { call.resolve(["notifications": await apns.requestPermission()]) }
    }

    @objc func openNotificationSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return call.resolve() }
            UIApplication.shared.open(url) { _ in call.resolve() }
        }
    }

    @objc func listDistributors(_ call: CAPPluginCall) {
        call.resolve(["distributors": [], "selected": NSNull()])
    }

    @objc func selectDistributor(_ call: CAPPluginCall) {
        call.unavailable("Push distributors exist only on Android.")
    }

    @objc func drainPendingRegistrations(_ call: CAPPluginCall) {
        call.resolve(["orgIds": []])
    }

    @objc func registerDevice(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), let installId = call.getString("installId"),
              let label = call.getString("label"), let gateway = Self.orgApi
        else { return call.reject("registerDevice needs orgId, installId, label and a bound org client", "invalid_argument") }
        let mutes = Self.mutes(call.getObject("mutes"))
        let request = RegisterRequest(
            orgId: orgId, installId: installId, label: label, locale: call.getString("locale"), mutes: mutes,
            pushOff: call.getBool("pushOff") ?? false, vapidPublicKey: call.getString("vapidPublicKey")
        )
        Task {
            guard let relay = try? RelayEndpointClient(baseURL: config.relayURL, appId: config.bundleId) else {
                return call.resolve(["outcome": "push_unavailable", "reason": "the push relay address is not HTTPS"])
            }
            let registrar = DeviceRegistrar(subscriptions: store, relay: relay, gateway: gateway, app: config.appInfo)
            let token = request.pushOff ? nil : await apns.token()
            let outcome = await registrar.register(request, apnsToken: token)
            if case .ok = outcome { state.setMutes(mutes, orgId: orgId) }
            call.resolve(Self.result(outcome))
        }
    }

    @objc func localState(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId") else { return call.reject("orgId is required", "invalid_argument") }
        let subscription = try? store.load(orgId: orgId)
        call.resolve([
            "subscribed": subscription?.endpoint != nil,
            "channel": subscription?.endpoint == nil ? NSNull() : "apns_relay",
            "endpointHost": subscription?.endpoint.flatMap { URL(string: $0)?.host } ?? NSNull(),
            "vapidPublicKey": subscription?.vapidPublicKey ?? NSNull(),
            "relayKeyId": subscription?.endpointKeyId ?? NSNull(),
        ])
    }

    @objc func forgetOrg(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId") else { return call.reject("orgId is required", "invalid_argument") }
        try? store.delete(orgId: orgId)
        state.forget(orgId: orgId)
        call.resolve()
    }

    @objc func setLocalMutes(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId") else { return call.reject("orgId is required", "invalid_argument") }
        state.setMutes(Self.mutes(call.getObject("mutes")), orgId: orgId)
        call.resolve()
    }

    @objc func cacheMachineNames(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), let orgName = call.getString("orgName") else {
            return call.reject("orgId and orgName are required", "invalid_argument")
        }
        var machines: [String: String] = [:]
        for case let entry as JSObject in call.getArray("machines") ?? [] {
            if let id = entry["id"] as? String, let name = entry["name"] as? String { machines[id] = name }
        }
        state.setDirectory(OrgDirectory(orgName: orgName, machines: machines), orgId: orgId)
        call.resolve()
    }

    @objc func setVisibleAgent(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), let machineId = call.getString("machineId"), let agentId = call.getString("agentId") else {
            visible = nil
            return call.resolve()
        }
        let tabId = call.getString("tabId")
        visible = VisibleAgent(orgId: orgId, machineId: machineId, agentId: agentId, tabId: tabId)
        Self.removeDelivered(DeliveredFilter(orgId: orgId, machineId: machineId, agentId: agentId, tab: .any)) { call.resolve() }
    }

    @objc func clearDelivered(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), let machineId = call.getString("machineId") else {
            return call.reject("orgId and machineId are required", "invalid_argument")
        }
        let tab: DeliveredFilter.TabMatch = call.getString("tabId").map { .exactly($0) } ?? .any
        Self.removeDelivered(DeliveredFilter(orgId: orgId, machineId: machineId, agentId: call.getString("agentId"), tab: tab)) {
            call.resolve()
        }
    }

    static func removeDelivered(_ filter: DeliveredFilter, done: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { filter.matches($0.request.content.userInfo) }.map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
            done()
        }
    }

    static func mutes(_ object: JSObject?) -> LocalMutes {
        let formatter = ISO8601DateFormatter()
        return LocalMutes(
            muteAll: object?["mute_all"] as? Bool ?? false,
            mutedUntil: (object?["muted_until"] as? String).flatMap(formatter.date(from:)),
            mutedMachineIds: (object?["muted_machine_ids"] as? [String]) ?? []
        )
    }

    static func result(_ outcome: RegisterOutcome) -> [String: Any] {
        switch outcome {
        case let .ok(device):
            return ["outcome": "ok", "device": (try? JSONSerialization.jsonObject(with: device)) ?? [:]]
        case let .api(result):
            switch result {
            case let .ok(_, device): return ["outcome": "ok", "device": (try? JSONSerialization.jsonObject(with: device)) ?? [:]]
            case let .apiError(status, code): return ["outcome": "api_error", "status": status, "code": code]
            case .sessionExpired: return ["outcome": "session_expired"]
            case .deviceRevoked: return ["outcome": "device_revoked"]
            case .offline: return ["outcome": "offline"]
            case .tlsError: return ["outcome": "tls_error"]
            case .refused: return ["outcome": "refused"]
            case .protocolUnsupported: return ["outcome": "protocol_unsupported"]
            }
        case .needsPermission: return ["outcome": "needs_permission"]
        case let .pushUnavailable(reason): return ["outcome": "push_unavailable", "reason": reason]
        case let .registrationFailed(reason): return ["outcome": "registration_failed", "reason": reason]
        }
    }
}

/// Build-time values from Info.plist (Phase 14's publisher config).
struct PushConfig {
    let appGroup: String
    let relayURL: URL
    let bundleId: String
    let appInfo: AppInfo

    init(bundle: Bundle) {
        let value = { (key: String) in bundle.object(forInfoDictionaryKey: key) as? String ?? "" }
        bundleId = bundle.bundleIdentifier ?? ""
        appGroup = value("YaranAppGroup")
        relayURL = URL(string: value("YaranRelayURL")) ?? URL(string: "https://relay.invalid")!
        appInfo = AppInfo(
            bundleId: bundleId, flavor: value("YaranFlavor").isEmpty ? "appstore" : value("YaranFlavor"),
            appVersion: value("CFBundleShortVersionString"),
            formFactor: UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone",
            apnsEnvironment: value("YaranApnsEnvironment") == "sandbox" ? "sandbox" : "production"
        )
    }
}
