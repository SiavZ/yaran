/// Phase 14's native core (`YaranCore`) behind this plugin's `CoreBindings` seams.
///
/// The app's AppDelegate calls `CoreAdapters.installDefault()` once at launch. The vault
/// adapter maps this plugin's names (`handoff`, `session/<host>`, `install/<orgId>`) onto the
/// core vault's namespace and key: the part before the first `/` is the namespace (one of the
/// native-only ones the secure-store plugin refuses to JS), and the rest, which can be longer
/// than a vault key and hold `:` or `/`, is stored under its SHA-256 and listed through a
/// standard-class index of names in the same namespace. The Android twin is `CoreAdapters.kt`.
///
/// - Values are UTF-8 text: every caller in this plugin writes JSON.
/// - The org directory reads the shell's org list (`orgs/list`), written at onboarding.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/CoreAdapters
/// ├── MachineViewCore/Seams (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/Diagnostics (inferred)
/// ├── YaranCore/ScreenPrivacy (inferred)
/// └── YaranCore/Vault (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// MachineViewCore/CoreAdapters
/// ├── App/AppDelegate (inferred)
/// └── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation
import YaranCore

public enum CoreAdapters {
    /// Installs the core-backed bindings on the shared vault, diagnostics log, lock and privacy.
    public static func installDefault() {
        let vault = Vault.shared
        CoreBindings.install(vault: VaultSecrets(vault), diagnostics: CoreDiagnostics(), orgs: OrgList(vault),
                             appLock: CoreAppLock(), screenPrivacy: CoreScreenPrivacy())
    }
}

public final class VaultSecrets: SecretVault {
    private let vault: Vault
    private let mutex = NSLock()
    static let singleKey = "value"
    static let indexKey = "names"

    public init(_ vault: Vault) { self.vault = vault }

    private struct Name { let namespace: String; let key: String; let name: String? }

    private func split(_ ns: String) -> Name {
        guard let slash = ns.firstIndex(of: "/") else { return Name(namespace: ns, key: Self.singleKey, name: nil) }
        let name = String(ns[ns.index(after: slash)...])
        let hash = SHA256.hash(data: Data(name.utf8)).map { String(format: "%02x", $0) }.joined()
        return Name(namespace: String(ns[..<slash]), key: hash, name: name)
    }

    public func read(_ ns: String) throws -> Data? {
        let n = split(ns)
        return try mapped { try vault.get(namespace: n.namespace, key: n.key) }.map { Data($0.utf8) }
    }

    public func write(_ ns: String, _ value: Data, _ cls: ProtectionClass) throws {
        let n = split(ns)
        let protection: Protection
        switch cls {
        case .standard: protection = .standard
        case .locked: protection = .locked
        }
        try locked {
            try mapped { try vault.set(namespace: n.namespace, key: n.key, value: String(decoding: value, as: UTF8.self), protection: protection) }
            if let name = n.name { try saveNames(n.namespace, names(n.namespace).union([name])) }
        }
    }

    public func delete(_ ns: String) throws {
        let n = split(ns)
        try locked {
            try mapped { try vault.remove(namespace: n.namespace, key: n.key) }
            if let name = n.name { try saveNames(n.namespace, names(n.namespace).subtracting([name])) }
        }
    }

    /// Every `<namespace>/<name>` under `prefix`, which must be `<namespace>/`.
    public func list(prefix: String) throws -> [String] {
        guard prefix.hasSuffix("/"), prefix.filter({ $0 == "/" }).count == 1 else { throw VaultError.unavailable }
        return try names(String(prefix.dropLast())).sorted().map { prefix + $0 }
    }

    private func names(_ namespace: String) throws -> Set<String> {
        let raw = try mapped { try vault.get(namespace: namespace, key: Self.indexKey) } ?? ""
        return Set(raw.split(separator: "\n").map(String.init))
    }

    private func saveNames(_ namespace: String, _ names: Set<String>) throws {
        try mapped {
            if names.isEmpty {
                try vault.remove(namespace: namespace, key: Self.indexKey)
            } else {
                try vault.set(namespace: namespace, key: Self.indexKey, value: names.sorted().joined(separator: "\n"), protection: .standard)
            }
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        mutex.lock()
        defer { mutex.unlock() }
        return try body()
    }

    /// The core's `locked` becomes this plugin's; every other core error passes through.
    private func mapped<T>(_ body: () throws -> T) throws -> T {
        do { return try body() } catch YaranCore.VaultError.locked { throw VaultError.locked }
    }
}

/// The org URL of an onboarded org; the shell keeps its org list in the vault at `orgs/list`.
public final class OrgList: OrgDirectory {
    private let vault: Vault
    public init(_ vault: Vault) { self.vault = vault }

    public func orgUrl(_ orgId: String) -> String? {
        guard let text = try? vault.get(namespace: "orgs", key: "list"),
              let orgs = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]] else { return nil }
        return orgs.contains { $0["id"] as? String == orgId } ? orgId : nil
    }
}

final class CoreDiagnostics: DiagnosticsSink {
    func append(_ line: String) { Diagnostics.shared.append(level: .info, message: line) }
}

final class CoreAppLock: AppLockState {
    func lockEnabled() -> Bool { AppLock.shared.status().enabled }
    func isLocked() -> Bool { AppLock.shared.locked }
}

final class CoreScreenPrivacy: ScreenPrivacyState {
    func enabled() -> Bool { ScreenPrivacy.isEnabled }
}
