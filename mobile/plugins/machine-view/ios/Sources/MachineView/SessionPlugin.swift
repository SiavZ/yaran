/// Capacitor adapter for `Session`: sign-in, session status, the org API, install id, sign-out.
///
/// Each method checks its arguments, calls the native client and resolves with the
/// `SignInOutcome` / `ApiResult` dictionary the TypeScript unions describe. No method
/// returns a JWT, a cookie or a private key (D22); `deviceKey` is the public key Phase 16
/// puts in `DeviceRegistration.device_key`.
///
/// - Main actor. Not compiled on this machine (Capacitor, UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/SessionPlugin
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/DirectFlow (inferred)
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// └── MachineViewCore/Seams (inferred)
/// External: Capacitor, UIKit
///
/// Used by: entry point (Capacitor plugin (CAPBridgedPlugin), registered by the app's Capacitor bridge)
/// <module-headers:end>
import Capacitor
import MachineViewCore
import UIKit

@objc(SessionPlugin)
public class SessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SessionPlugin"
    public let jsName = "Session"
    public let pluginMethods: [CAPPluginMethod] = ["meta", "signIn", "status", "request", "installId", "deviceKey",
                                                   "callbackMode", "signOut", "directStatus", "directSignIn",
                                                   "directSignOut", "routeStatus"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    @objc func meta(_ call: CAPPluginCall) {
        let orgUrl = call.getString("orgUrl") ?? ""
        Task { @MainActor in call.resolve(await AppServices.shared.api.meta(orgUrl: orgUrl).jsObject) }
    }

    @objc func signIn(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), !orgId.isEmpty else { return call.reject("orgId is required", "invalid_argument") }
        let request: SignInRequest
        if call.getString("target") == "control-plane" {
            request = .controlPlane
        } else if let host = call.getObject("target")?["machineHost"] as? String {
            request = .machine(host: host)
        } else {
            return call.reject("target must be \"control-plane\" or {machineHost}", "invalid_argument")
        }
        DispatchQueue.main.async {
            AppServices.shared.handoff.signIn(orgId: orgId, request: request) { call.resolve($0.jsObject) }
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        let host = call.getString("host") ?? ""
        DispatchQueue.main.async {
            let status = AppServices.shared.sessions.status(host, now: AppServices.now())
            var out: [String: Any] = ["signedIn": status.signedIn]
            if let exp = status.expiresAt { out["expiresAt"] = exp }
            call.resolve(out)
        }
    }

    @objc func request(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), let method = call.getString("method"), let path = call.getString("path") else {
            return call.reject("orgId, method and path are required", "invalid_argument")
        }
        let body = call.options["body"]
        Task { @MainActor in
            call.resolve(await AppServices.shared.api.request(orgId: orgId, method: method, path: path, body: body).jsObject)
        }
    }

    @objc func installId(_ call: CAPPluginCall) { identity(call) { ["installId": $0.installId] } }

    @objc func deviceKey(_ call: CAPPluginCall) { identity(call) { ["deviceKey": $0.publicKey] } }

    @objc func callbackMode(_ call: CAPPluginCall) {
        switch AppServices.callbackMode() {
        case .https(let domain): call.resolve(["mode": "https", "domain": domain])
        case .dev: call.resolve(["mode": "dev"])
        }
    }

    @objc func signOut(_ call: CAPPluginCall) {
        guard let orgId = call.getString("orgId"), !orgId.isEmpty else { return call.reject("orgId is required", "invalid_argument") }
        let hosts = (call.getArray("hosts") ?? []).compactMap { $0 as? String }.filter { Pattern.hostname.matches($0) }
        DispatchQueue.main.async {
            let services = AppServices.shared
            do {
                try services.sessions.wipe(orgId: orgId, extraHosts: hosts, deviceKeys: services.deviceKeys, cleaner: services.cleaner)
                call.resolve()
            } catch VaultError.locked {
                call.reject("Unlock the app to sign out.", "vault_locked")
            } catch {
                // An unreadable listing or record: nothing was deleted, and the device identity stays.
                call.reject("the sign-out did not finish", "native_error")
            }
        }
    }

    @objc func directStatus(_ call: CAPPluginCall) {
        guard let host = call.getString("host") else { return call.reject("host is required", "invalid_argument") }
        Task { @MainActor in call.resolve(await DirectFlow.status(host: host).jsObject) }
    }

    @objc func directSignIn(_ call: CAPPluginCall) {
        guard let host = call.getString("host") else { return call.reject("host is required", "invalid_argument") }
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else { return call.reject("no window to show the sign-in in", "unavailable") }
            DirectFlow.signIn(from: presenter, host: host) { call.resolve($0.jsObject) }
        }
    }

    @objc func directSignOut(_ call: CAPPluginCall) {
        guard let host = call.getString("host") else { return call.reject("host is required", "invalid_argument") }
        let signInId = call.getString("signInId")
        if let signInId, signInId.range(of: #"^[A-Za-z0-9_-]{22}$"#, options: .regularExpression) == nil {
            return call.reject("signInId is malformed", "invalid_argument")
        }
        Task { @MainActor in call.resolve(await DirectFlow.signOut(host: host, signInId: signInId).jsObject) }
    }

    @objc func routeStatus(_ call: CAPPluginCall) {
        guard let object = call.getObject("route"), let route = MachineRoute(object) else {
            return call.reject("route must be {kind:\"org\", orgId, machineId, host} or {kind:\"direct\", host}", "invalid_argument")
        }
        Task { @MainActor in call.resolve(await DirectFlow.routeStatus(route)) }
    }

    private func identity(_ call: CAPPluginCall, _ shape: @escaping (DeviceIdentity) -> [String: Any]) {
        guard let orgId = call.getString("orgId"), !orgId.isEmpty else { return call.reject("orgId is required", "invalid_argument") }
        DispatchQueue.main.async {
            do { call.resolve(shape(try AppServices.shared.deviceKeys.ensure(orgId))) } catch VaultError.locked {
                call.reject("Unlock the app to read this phone's registration.", "vault_locked")
            } catch {
                call.reject("the native session call failed", "native_error") // Android's code for the same failure
            }
        }
    }
}
