/// PluginCallResult: the one resolve-or-reject path every secure-store adapter uses.
///
/// Runs an adapter body, resolves with its result, or rejects with the stable code that
/// `PluginArguments.code(for:)` picks, so no adapter hand-writes an error string.
///
/// - The message equals the code: the shell maps codes to localized sentences itself.
///
/// <module-headers:begin>
/// Uses:
/// YaranSecureStorePlugin/PluginCallResult
/// └── YaranCore/PluginArguments (inferred)
/// External: Capacitor, Foundation
///
/// Used by: entry point (CAPPluginCall extension used by the *Plugin.swift adapters in the same module)
/// <module-headers:end>

import Capacitor
import Foundation
import YaranCore

extension CAPPluginCall {
    /// Resolves with `body()`'s result, or rejects with a stable error code.
    func run(_ body: () throws -> PluginCallResultData?) {
        do {
            if let data = try body() { resolve(data) } else { resolve() }
        } catch {
            let code = PluginArguments.code(for: error).rawValue
            reject(code, code)
        }
    }
}
