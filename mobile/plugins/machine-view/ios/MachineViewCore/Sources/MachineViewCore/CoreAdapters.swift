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
/// - `lockStateChanged` is the core's own App Lock notification, for UIKit code that does
///   not import `YaranCore`.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/CoreAdapters
/// ├── MachineViewCore/Seams (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/Diagnostics (inferred)
/// ├── YaranCore/ScreenPrivacy (inferred)
/// └── YaranCore/Vault (inferred)
/// External: CryptoKit, Darwin, Foundation
///
/// Used by:
/// MachineViewCore/CoreAdapters
/// ├── App/AppDelegate (inferred)
/// ├── MachineView/MachineViewController (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// └── MachineViewCoreTests/LockTests (inferred)
/// <module-headers:end>
import CryptoKit
import Darwin
import Foundation
import YaranCore

public enum CoreAdapters {
    /// Installs the core-backed bindings on the shared vault, diagnostics log, lock and privacy.
    public static func installDefault() {
        let vault = Vault.shared
        CoreBindings.install(vault: VaultSecrets(vault), diagnostics: CoreDiagnostics(), orgs: OrgList(vault),
                             appLock: CoreAppLock(), screenPrivacy: CoreScreenPrivacy())
    }

    /// Posted (any thread) whenever App Lock locks or unlocks.
    public static let lockStateChanged = AppLock.lockStateChanged
}

public final class VaultSecrets: SecretVault {
    private let vault: Vault
    private let mutex = NSLock()
    static let singleKey = "value"
    static let indexKey = "names"

    public init(_ vault: Vault) { self.vault = vault }

    private struct Name { let namespace: String; let key: String; let name: String? }

    private func split(_ path: String) -> Name {
        guard let slash = path.firstIndex(of: "/") else { return Name(namespace: path, key: Self.singleKey, name: nil) }
        let name = String(path[path.index(after: slash)...])
        let hash = SHA256.hash(data: Data(name.utf8)).map { String(format: "%02x", $0) }.joined()
        return Name(namespace: String(path[..<slash]), key: hash, name: name)
    }

    public func read(_ path: String) throws -> Data? {
        let target = split(path)
        return try mapped { try vault.get(namespace: target.namespace, key: target.key) }.map { Data($0.utf8) }
    }

    public func write(_ path: String, _ value: Data, _ cls: ProtectionClass) throws {
        let target = split(path)
        let protection: Protection
        switch cls {
        case .standard: protection = .standard
        case .locked: protection = .locked
        }
        // Values are JSON; bytes that are not UTF-8 are refused rather than replaced.
        guard let text = String(bytes: value, encoding: .utf8) else { throw YaranCore.VaultError.invalidArgument }
        try locked {
            try mapped { try vault.set(namespace: target.namespace, key: target.key, value: text, protection: protection) }
            if let name = target.name { try saveNames(target.namespace, names(target.namespace).union([name])) }
        }
    }

    public func delete(_ path: String) throws {
        let target = split(path)
        try locked {
            try mapped { try vault.remove(namespace: target.namespace, key: target.key) }
            if let name = target.name { try saveNames(target.namespace, names(target.namespace).subtracting([name])) }
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
    private let lock: AppLock
    init(_ lock: AppLock = .shared) { self.lock = lock }
    func lockEnabled() -> Bool { lock.status().enabled }
    func isLocked() -> Bool { lock.locked }
    // The same continuous monotonic clock as SceneDelegate, including time asleep.
    func holdForExternalFlow(ttlMs: Int64) { lock.holdForExternalFlow(ttlMs: ttlMs, nowMs: Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) / 1_000_000)) }
    func releaseExternalFlow() { lock.releaseExternalFlow() }
}

final class CoreScreenPrivacy: ScreenPrivacyState {
    func enabled() -> Bool { ScreenPrivacy.isEnabled }
}
