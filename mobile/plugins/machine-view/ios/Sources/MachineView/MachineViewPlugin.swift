/// Capacitor adapter for `MachineView.open` / `close` and the `closed` event.
///
/// Validates the arguments (a Hostname, an agent route from the restricted grammar, non-empty
/// ids), presents one full-screen `MachineViewController` from the bridge's view controller
/// (opening another machine replaces the current one), and reports how it went away.
///
/// - Main actor. No logic beyond argument checks. Not compiled on this machine (Capacitor, UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewPlugin
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// └── MachineViewCore/RouteFragment (inferred)
/// External: Capacitor, UIKit
///
/// Used by: entry point (Capacitor plugin (CAPBridgedPlugin), registered by the app's Capacitor bridge)
/// <module-headers:end>
import Capacitor
import MachineViewCore
import UIKit

@objc(MachineViewPlugin)
public class MachineViewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MachineViewPlugin"
    public let jsName = "MachineView"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
    ]

    private weak var current: MachineViewController?

    @objc func open(_ call: CAPPluginCall) {
        let orgId = call.getString("orgId") ?? "", machineId = call.getString("machineId") ?? ""
        let host = call.getString("host") ?? ""
        let route = call.getString("route")
        guard !orgId.isEmpty, !machineId.isEmpty else { return call.reject("orgId and machineId are required", "invalid_argument") }
        guard Pattern.hostname.matches(host) else { return call.reject("host must be a lowercase DNS name", "invalid_argument") }
        if let route, !RouteFragment.isValid(route) {
            return call.reject("route must be #/agent/<id> with an optional /tab/<id>", "invalid_argument")
        }
        DispatchQueue.main.async {
            self.present(MachineViewController.Target(orgId: orgId, machineId: machineId, host: host, route: route))
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.current?.close("user")
            call.resolve()
        }
    }

    @MainActor
    private func present(_ target: MachineViewController.Target) {
        let show = { [weak self] in
            guard let self, let host = self.bridge?.viewController else { return }
            let vc = MachineViewController(target: target, services: .shared) { [weak self] reason, code in
                var data: [String: Any] = ["reason": reason]
                if let code { data["code"] = code }
                self?.notifyListeners("closed", data: data)
            }
            self.current = vc
            host.present(vc, animated: true)
        }
        if let current {
            current.close("user")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { show() } // after the dismissal animation
        } else {
            show()
        }
    }
}
