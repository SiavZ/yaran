/// `Push.registerDevice` on iOS: the per-org subscription, the relay endpoint and the W12 call.
///
/// Reuses the org's subscription while its endpoint is still bound to the current VAPID key
/// and relay key id, otherwise mints a fresh key, auth secret and registration id and a new
/// relay endpoint. It then builds 02's `DeviceRegistration` with `push` and `device_key` filled
/// natively and sends it through Phase 15's client. Push off sends `{kind: none}` and deletes
/// the local keys; it never deletes the device (a revoked device would lose the whole org).
///
/// - No endpoint, key or credential is returned: the outcome carries only the Worker's
///   `Device`, which never echoes the endpoint (D22).
///
/// <module-headers:begin>
/// Uses:
/// YaranPushRegistration/DeviceRegistrar
/// ├── YaranPushCore/PushSubscriptionStore (inferred)
/// ├── YaranPushCore/SharedPushState (inferred)
/// ├── YaranPushRegistration/OrgApiGateway (inferred)
/// └── YaranPushRegistration/RelayEndpointClient (inferred)
/// External: Foundation
///
/// Used by:
/// YaranPushRegistration/DeviceRegistrar
/// ├── PushPlugin/PushPlugin (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import Foundation
import YaranPushCore

/// Native facts the registration carries that JS does not choose.
public struct AppInfo: Equatable, Sendable {
    public let bundleId: String
    public let flavor: String
    public let appVersion: String
    public let formFactor: String
    public let apnsEnvironment: String

    public init(bundleId: String, flavor: String, appVersion: String, formFactor: String, apnsEnvironment: String) {
        self.bundleId = bundleId
        self.flavor = flavor
        self.appVersion = appVersion
        self.formFactor = formFactor
        self.apnsEnvironment = apnsEnvironment
    }
}

public struct RegisterRequest: Equatable, Sendable {
    public let orgId: String
    public let installId: String
    public let label: String
    public let locale: String?
    public let mutes: LocalMutes
    public let pushOff: Bool
    /// `Meta.push.vapid_public_key`, read by the shell through `Session.meta`.
    public let vapidPublicKey: String?

    public init(orgId: String, installId: String, label: String, locale: String?, mutes: LocalMutes, pushOff: Bool, vapidPublicKey: String?) {
        self.orgId = orgId
        self.installId = installId
        self.label = label
        self.locale = locale
        self.mutes = mutes
        self.pushOff = pushOff
        self.vapidPublicKey = vapidPublicKey
    }
}

/// What crosses the bridge: the `Device` JSON or a reason, never key material.
public enum RegisterOutcome: Error, Equatable, Sendable {
    case ok(device: Data)
    case api(OrgApiResult)
    case needsPermission
    case pushUnavailable(reason: String)
    case registrationFailed(reason: String)
}

public struct DeviceRegistrar: Sendable {
    let subscriptions: PushSubscriptionStore
    let relay: RelayEndpointClient
    let gateway: OrgApiGateway
    let app: AppInfo

    public init(subscriptions: PushSubscriptionStore, relay: RelayEndpointClient, gateway: OrgApiGateway, app: AppInfo) {
        self.subscriptions = subscriptions
        self.relay = relay
        self.gateway = gateway
        self.app = app
    }

    public func register(_ request: RegisterRequest, apnsToken: String?) async -> RegisterOutcome {
        let deviceKey: String
        do {
            deviceKey = try await gateway.devicePublicKey(orgId: request.orgId)
        } catch {
            return .registrationFailed(reason: "the device key for this organization is unavailable")
        }
        let push: [String: Any]
        if request.pushOff {
            try? subscriptions.delete(orgId: request.orgId)
            push = ["kind": "none"]
        } else {
            guard let apnsToken else { return .needsPermission }
            guard let vapid = request.vapidPublicKey else { return .pushUnavailable(reason: "push is turned off for this organization") }
            switch await subscription(orgId: request.orgId, token: apnsToken, vapid: vapid) {
            case let .failure(outcome): return outcome
            case let .success(subscription):
                guard let endpoint = subscription.endpoint, let p256dh = try? subscription.p256dh() else {
                    return .registrationFailed(reason: "the push subscription is incomplete")
                }
                push = [
                    "kind": "webpush", "channel": "apns_relay", "endpoint": endpoint,
                    "keys": ["p256dh": p256dh, "auth": subscription.auth],
                ]
            }
        }
        let body = Self.registrationBody(request: request, deviceKey: deviceKey, app: app, platform: "ios", push: push)
        guard let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            return .registrationFailed(reason: "the registration could not be encoded")
        }
        let result = await gateway.registerDevice(orgId: request.orgId, body: data)
        if case let .ok(_, device) = result { return .ok(device: device) }
        if case .deviceRevoked = result { try? subscriptions.delete(orgId: request.orgId) }
        return .api(result)
    }

    /// Reuses the stored subscription while its endpoint is bound to this VAPID key, relay key id
    /// and APNs token; any change mints a fresh key, registration id and endpoint.
    func subscription(orgId: String, token: String, vapid: String) async -> Result<PushSubscription, RegisterOutcome> {
        let kid: String
        do {
            kid = try await relay.endpointKeyId(channel: .apns)
        } catch let error as RelayError {
            return .failure(Self.outcome(error))
        } catch {
            return .failure(.pushUnavailable(reason: "the push relay is unreachable"))
        }
        let stored = try? subscriptions.load(orgId: orgId)
        if let stored, stored.endpoint != nil, stored.vapidPublicKey == vapid, stored.endpointKeyId == kid,
           stored.transportToken == token {
            return .success(stored)
        }
        do {
            var fresh = try subscriptions.mint(orgId: orgId)
            let body = relay.apnsMintBody(token: token, environment: app.apnsEnvironment, vapidPublicKey: vapid, registrationId: fresh.registrationId)
            fresh.endpoint = try await relay.mint(body: body)
            fresh.endpointKeyId = kid
            fresh.vapidPublicKey = vapid
            fresh.transportToken = token
            try subscriptions.save(fresh)
            return .success(fresh)
        } catch let error as RelayError {
            return .failure(Self.outcome(error))
        } catch {
            return .failure(.registrationFailed(reason: "the push keys could not be stored"))
        }
    }

    static func outcome(_ error: RelayError) -> RegisterOutcome {
        switch error {
        case .insecureBaseURL: .pushUnavailable(reason: "the push relay address is not HTTPS")
        case .notYaranRelay: .pushUnavailable(reason: "the push relay address does not answer as a yaran relay")
        case .appNotServed: .pushUnavailable(reason: "the push relay does not serve this app")
        case .channelNotServed: .pushUnavailable(reason: "the push relay does not deliver to Apple devices")
        case let .rateLimited(retryAfter): .pushUnavailable(reason: "the push relay is busy; retry in \(retryAfter ?? 60) seconds")
        case let .unavailable(status): .pushUnavailable(reason: "the push relay is unavailable (HTTP \(status))")
        case let .api(_, code): .registrationFailed(reason: "the push relay refused the registration (\(code))")
        case .malformedResponse: .pushUnavailable(reason: "the push relay sent an unreadable answer")
        case .network: .pushUnavailable(reason: "the push relay is unreachable")
        }
    }

    /// 02 `DeviceRegistration`, exactly its fields.
    static func registrationBody(request: RegisterRequest, deviceKey: String, app: AppInfo, platform: String, push: [String: Any]) -> [String: Any] {
        var body: [String: Any] = [
            "install_id": request.installId, "device_key": deviceKey, "platform": platform,
            "flavor": app.flavor, "form_factor": app.formFactor, "app_version": app.appVersion,
            "label": String(request.label.prefix(64)), "push": push,
            "mute_all": request.mutes.muteAll,
            "muted_until": request.mutes.mutedUntil.map(timestamp) ?? NSNull(),
            "muted_machine_ids": Array(request.mutes.mutedMachineIds.prefix(100)),
        ]
        if let locale = request.locale { body["locale"] = locale }
        return body
    }

    /// 02 `Timestamp`: seconds precision, `Z`.
    static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
