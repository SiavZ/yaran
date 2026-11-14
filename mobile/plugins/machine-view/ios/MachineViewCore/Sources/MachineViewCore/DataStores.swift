/// One persistent WKWebsiteDataStore per machine host (iOS 17 `forIdentifier:`).
///
/// Separate stores isolate machines from each other and keep the web UI's per-device
/// `localStorage` choices (typing surface, theater) across renewals. The identifier is derived
/// from the host (a name-based UUID), so it needs no stored record and sign-out or org removal
/// can always find the store to remove.
///
/// - Main actor. Removal fails while a web view still uses the store; close the window first.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/DataStores
/// └── MachineViewCore/Seams (inferred)
/// External: CryptoKit, Foundation, WebKit
///
/// Used by:
/// MachineViewCore/DataStores
/// ├── MachineView/AppServices (inferred)
/// ├── MachineView/WebViewFactory (inferred)
/// └── MachineViewCoreTests/WebKitTests (inferred)
/// <module-headers:end>
#if canImport(WebKit)
import CryptoKit
import Foundation
import WebKit

public enum DataStores {
    /// SHA-256 of a tagged host, shaped as an RFC 4122 version-5-style UUID.
    public static func identifier(host: String) -> UUID {
        var b = [UInt8](SHA256.hash(data: Data("yaran-machine-store-v1\n\(host)".utf8)).prefix(16))
        b[6] = (b[6] & 0x0F) | 0x50
        b[8] = (b[8] & 0x3F) | 0x80
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
    }

    @MainActor
    public static func store(host: String) -> WKWebsiteDataStore { WKWebsiteDataStore(forIdentifier: identifier(host: host)) }

    @MainActor
    public static func remove(host: String) async throws {
        try await WKWebsiteDataStore.remove(forIdentifier: identifier(host: host))
    }
}

/// The production `WebDataCleaner`: drops each host's whole data store (cookies included).
public final class WebKitDataCleaner: WebDataCleaner {
    private let diagnostics: DiagnosticsSink?
    public init(diagnostics: DiagnosticsSink?) { self.diagnostics = diagnostics }

    public func clear(hosts: [String]) {
        Task { @MainActor in
            for host in hosts {
                // The network process lets go of a closed window's store asynchronously.
                var removed = false
                for attempt in 0..<10 where !removed {
                    if attempt > 0 { try? await Task.sleep(nanoseconds: 200_000_000) }
                    removed = (try? await DataStores.remove(host: host)) != nil
                }
                if !removed { diagnostics?.append(diagLine("data store removal failed", [("host", host)])) }
            }
        }
    }
}
#endif
