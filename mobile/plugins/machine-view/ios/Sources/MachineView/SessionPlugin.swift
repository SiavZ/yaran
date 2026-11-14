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
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// └── MachineViewCore/Patterns (inferred)
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
                                                   "callbackMode", "signOut"].map {
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
            let s = AppServices.shared.sessions.status(host, now: AppServices.now())
            var out: [String: Any] = ["signedIn": s.signedIn]
            if let exp = s.expiresAt { out["expiresAt"] = exp }
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
            let s = AppServices.shared
            do {
                try s.sessions.wipe(orgId: orgId, extraHosts: hosts, deviceKeys: s.deviceKeys, cleaner: s.cleaner)
                call.resolve()
            } catch {
                call.reject("Unlock the app to sign out.", "vault_locked")
            }
        }
    }

    private func identity(_ call: CAPPluginCall, _ shape: @escaping (DeviceIdentity) -> [String: Any]) {
        guard let orgId = call.getString("orgId"), !orgId.isEmpty else { return call.reject("orgId is required", "invalid_argument") }
        DispatchQueue.main.async {
            do { call.resolve(shape(try AppServices.shared.deviceKeys.ensure(orgId))) } catch {
                call.reject("Unlock the app to read this phone's registration.", "vault_locked")
            }
        }
    }
}
