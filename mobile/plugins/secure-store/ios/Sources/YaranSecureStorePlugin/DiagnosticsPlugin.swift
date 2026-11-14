/// DiagnosticsPlugin: the `Diagnostics` bridge object over the native ring log.
///
/// `append` sanitizes and keeps an entry, `read` returns the sanitized text for the shell's
/// preview, and `export` opens the system share sheet (`UIActivityViewController`) on the log
/// file, so the user decides where it goes; nothing is uploaded by the app.
///
/// - The share sheet is anchored to the bridge view, which iPad popovers require.
///
/// <module-headers:begin>
/// Uses:
/// YaranSecureStorePlugin/DiagnosticsPlugin
/// ├── YaranCore/Diagnostics (inferred)
/// └── YaranCore/PluginArguments (inferred)
/// External: Capacitor, Foundation, UIKit
///
/// Used by: entry point (Capacitor bridge class, listed in packageClassList by the Capacitor CLI sync)
/// <module-headers:end>

import Capacitor
import Foundation
import UIKit
import YaranCore

@objc(DiagnosticsPlugin)
public class DiagnosticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DiagnosticsPlugin"
    public let jsName = "Diagnostics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "append", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "export", returnType: CAPPluginReturnPromise),
    ]

    @objc func append(_ call: CAPPluginCall) {
        call.run {
            let level = try PluginArguments.level(call.getString("level"))
            let message = try PluginArguments.value(call.getString("message"))
            Diagnostics.shared.append(level: level, message: message)
            return nil
        }
    }

    @objc func read(_ call: CAPPluginCall) {
        call.run { ["text": Diagnostics.shared.read()] }
    }

    @objc func export(_ call: CAPPluginCall) {
        let file = Diagnostics.shared.fileURL
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController, FileManager.default.fileExists(atPath: file.path) else {
                call.reject(PluginErrorCode.unavailable.rawValue, PluginErrorCode.unavailable.rawValue)
                return
            }
            let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = presenter.view
            sheet.popoverPresentationController?.sourceRect = CGRect(
                x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            sheet.completionWithItemsHandler = { _, completed, _, _ in
                call.resolve(["outcome": completed ? "shared" : "cancelled"])
            }
            presenter.present(sheet, animated: true)
        }
    }
}
