/// GateSpikeViewController: the Capacitor bridge host that registers the in-app spike plugins.
///
/// Capacitor only auto-registers npm plugins, so the three local spike plugins are handed to
/// the bridge here, in `capacitorDidLoad`, the documented hook for app-local plugins.
///
/// - Main thread; holds no state. Its bridge WebView is the only bridge-enabled page (D9);
///   machine-view's WKWebView is a separate instance with no bridge.
///
/// <module-headers:begin>
/// Uses:
/// App/GateSpikeViewController
/// ├── App/AuthSpike (inferred)
/// ├── App/MachineViewSpike (inferred)
/// └── App/PushSpike (inferred)
/// External: Capacitor, UIKit
///
/// Used by:
/// App/GateSpikeViewController
/// └── App/SceneDelegate (inferred)
/// <module-headers:end>
import Capacitor
import UIKit

class GateSpikeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(MachineViewSpike())
        bridge?.registerPluginInstance(AuthSpike())
        bridge?.registerPluginInstance(PushSpike())
    }
}
