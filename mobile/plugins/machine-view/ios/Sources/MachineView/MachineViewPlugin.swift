/// Capacitor adapter for `MachineView`: open (org, direct and routes forms), close, the held
/// share (G5), and the `closed` and `shareReceived` events.
///
/// Validates the arguments (an OrgUrl and machine id for an org route, a public host for a
/// direct one, at most four distinct routes, the instance, an agent route from the restricted
/// grammar), presents one full-screen `MachineViewController` from the bridge's view
/// controller (opening another machine replaces the current one), and reports how it went
/// away. `ShareIntake` takes the scene's file URLs and tells JS only a count, after unlock.
///
/// - Main actor. No logic beyond argument checks. Not compiled on this machine (Capacitor, UIKit).
///
/// <module-headers:begin>
/// Uses:
/// MachineView/MachineViewPlugin
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCore/Direct (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/RouteFragment (inferred)
/// ├── MachineViewCore/Seams (inferred)
/// ├── MachineViewCore/ShareInbox (inferred)
/// └── MachineViewCore/WindowSlot (inferred)
/// External: Capacitor, UIKit
///
/// Used by: entry point (Capacitor plugin (CAPBridgedPlugin), registered by the app's Capacitor bridge)
/// MachineView/MachineViewPlugin
/// └── App/SceneDelegate (inferred)
/// <module-headers:end>
import Capacitor
import MachineViewCore
import UIKit

/// Files the scene was handed ("Open in yaran"), announced to JS as a count once unlocked (G5).
@MainActor
public enum ShareIntake {
    fileprivate static var waiting: ShareEvent?
    fileprivate static weak var plugin: MachineViewPlugin?

    /// The scene delegate's entry for file URLs; true when it took them.
    @discardableResult
    public static func receive(_ urls: [URL]) -> Bool {
        let files = urls.filter(\.isFileURL)
        guard !files.isEmpty else { return false }
        let supported: Bool
        if #available(iOS 18.4, *) { supported = true } else { supported = false }
        waiting = AppServices.shared.shareInbox.intake(files, supported: supported)
        flush()
        return true
    }

    /**
     * A scene's cold start. Shared files stay native, as on a warm start. Capacitor's own
     * `SceneDelegateProxy.scene(_:willConnectTo:options:)` would replay every URL the scene was
     * launched with to JS once the bridge appears (`App.getLaunchUrl` reads the proxy's `lastURL`;
     * `appUrlOpen` hears its `openURL` notification), file paths and names included, and
     * `UIScene.ConnectionOptions` cannot be copied without them. So the options never reach the
     * proxy: this posts its will-connect notification and replays, at the same moment, exactly what
     * it would replay minus the file URLs (links and user activities, through its public methods).
     */
    @MainActor
    public static func connect(_ scene: UIScene, options: UIScene.ConnectionOptions) {
        let contexts = options.urlContexts
        let links = contexts.filter { !$0.url.isFileURL }
        receive(contexts.subtracting(links).map(\.url))
        // Both are only touched on the main queue: here, and in the observer registered on `.main`.
        nonisolated(unsafe) let activities = options.userActivities
        NotificationCenter.default.post(name: .capacitorSceneWillConnect, object: scene)
        nonisolated(unsafe) let once = ObserverToken()
        once.token = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { _ in
            if let token = once.token { NotificationCenter.default.removeObserver(token) }
            MainActor.assumeIsolated {
                if !links.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: links) }
                for activity in activities { SceneDelegateProxy.shared.scene(scene, continue: activity) }
            }
        }
    }

    /// The cold-start replay's own observer, removed once it has run.
    final class ObserverToken { var token: NSObjectProtocol? }

    static func flush() {
        guard let event = waiting, CoreBindings.appLock?.isLocked() != true, let plugin else { return }
        waiting = nil
        plugin.notifyListeners("shareReceived", data: event.jsObject, retainUntilConsumed: true)
    }
}

@objc(MachineViewPlugin)
public class MachineViewPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MachineViewPlugin"
    public let jsName = "MachineView"
    public let pluginMethods: [CAPPluginMethod] = ["open", "close", "shareStatus", "discardShare"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    /// The window shown and the open waiting to replace it; claimed files of an open that never shows go.
    @MainActor private lazy var slot = WindowSlot<MachineViewController>(close: { $0.close("user") },
                                                              release: { AppServices.shared.shareInbox.remove($0) })
    private static let instancePattern = Pattern("[\\x21-\\x7e]{1,128}")

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(lockChanged), name: CoreAdapters.lockStateChanged, object: nil)
        DispatchQueue.main.async {
            ShareIntake.plugin = self
            ShareIntake.flush()
        }
    }

    @objc private func lockChanged() { DispatchQueue.main.async { ShareIntake.flush() } }

    /// The three open forms (org, direct, routes) as one validated route list, or nil.
    static func routes(_ call: CAPPluginCall) -> (kind: String, routes: [MachineRoute], instance: String?)? {
        let kind = call.getString("kind") ?? "org"
        let instance = call.getString("instance")
        if let instance, !instancePattern.matches(instance) { return nil }
        switch kind {
        case "org":
            let object: [String: Any] = ["kind": "org", "orgId": call.getString("orgId") ?? "", "machineId": call.getString("machineId") ?? "",
                                         "host": call.getString("host") ?? ""]
            guard instance == nil, let route = MachineRoute(object) else { return nil }
            return (kind, [route], nil)
        case "direct":
            guard let route = MachineRoute(["kind": "direct", "host": call.getString("host") ?? ""]) else { return nil }
            return (kind, [route], instance)
        case "routes":
            let list = (call.getArray("routes") ?? []).compactMap { ($0 as? [String: Any]).flatMap(MachineRoute.init) }
            guard let instance, (1...4).contains(list.count), list.count == call.getArray("routes")?.count,
                  Set(list.map(\.host)).count == list.count else { return nil }
            return (kind, list, instance)
        default:
            return nil
        }
    }

    @objc func open(_ call: CAPPluginCall) {
        let route = call.getString("route")
        if let route, !RouteFragment.isValid(route) {
            return call.reject("route must be #/agent/<id> with an optional /tab/<id>", "invalid_argument")
        }
        guard let form = Self.routes(call) else { return call.reject("the open options are invalid", "invalid_argument") }
        // `share: true` was replaced by `shareBatch`: never let an old call succeed without its files.
        if call.options["share"] != nil { return call.reject("share is replaced by shareBatch", "invalid_arguments") }
        let named = call.options["shareBatch"] != nil
        let shareBatch = call.getString("shareBatch")
        if named, !ShareCommand.valid(shareBatch) { return call.reject("shareBatch is malformed", "invalid_arguments") }
        DispatchQueue.main.async {
            var files: [URL] = []
            if let shareBatch {
                switch ShareCommand.open(AppServices.shared.shareInbox, batch: shareBatch) {
                case .success(let taken): files = taken
                case .failure(let failure): return call.reject("the shared files were not handed over", failure.rawValue)
                }
            }
            self.present(MachineViewController.Target(kind: form.kind, routes: form.routes, instance: form.instance, route: route, shared: files))
            call.resolve()
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.slot.closeAll()
            call.resolve()
        }
    }

    @objc func shareStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let inbox = AppServices.shared.shareInbox
            if let batch = inbox.batch, inbox.count > 0 {
                call.resolve(["kind": "pending", "count": inbox.count, "batch": batch])
            } else {
                call.resolve(["kind": "none"])
            }
        }
    }

    @objc func discardShare(_ call: CAPPluginCall) {
        let batch = call.getString("batch")
        DispatchQueue.main.async {
            if let failure = ShareCommand.discard(AppServices.shared.shareInbox, batch: batch, waiting: &ShareIntake.waiting) {
                return call.reject("the shared files were not discarded", failure.rawValue)
            }
            call.resolve()
        }
    }

    /// Shows `target` now, or from the current window's own dismissal completion (`WindowSlot`).
    @MainActor
    private func present(_ target: MachineViewController.Target) {
        slot.open(files: target.shared) { [weak self] in
            guard let self, let host = self.bridge?.viewController else { return nil }
            weak var made: MachineViewController?
            let controller = MachineViewController(target: target, services: .shared) { [weak self] payload in
                self?.notifyListeners("closed", data: payload)
                if let made { self?.slot.dismissed(made) }
            }
            made = controller
            host.present(controller, animated: true)
            return controller
        }
    }
}
