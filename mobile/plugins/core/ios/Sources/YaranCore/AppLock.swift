/// AppLock: the optional biometric lock over the Vault's `locked` class (iOS).
///
/// Unlocking IS reading the guarded data key from the Keychain, which is what shows Face ID or
/// Touch ID; there is no bare `evaluatePolicy` gate anywhere. A guarded item that has vanished
/// (biometrics re-enrolled, passcode removed) wipes the `locked` class and reports
/// `invalidated`, leaving `standard` values (the org list) in place.
///
/// - Settings (enabled, passcode fallback, grace) persist in a Vault metadata item, out of
///   reach of the JS namespaces.
/// - `shouldLock` is the pure grace-period rule; the scene lifecycle feeds it timestamps.
/// - A browser sign-in the app launched holds the lock open (`holdForExternalFlow`) until its
///   callback is stored or it ends, never outside `[start, start + ttl]`; an unlock voids the
///   background mark.
/// - `lockStateChanged` notifications drive the native cover and the plugin event.
///
/// <module-headers:begin>
/// Uses:
/// YaranCore/AppLock
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Foundation, LocalAuthentication
///
/// Used by:
/// YaranCore/AppLock
/// ├── App/SceneDelegate (inferred)
/// ├── MachineViewCore/CoreAdapters (inferred)
/// ├── MachineViewCoreTests/CoreAdaptersTests (inferred)
/// ├── MachineViewCoreTests/LockTests (inferred)
/// ├── YaranCore/PluginArguments (inferred)
/// ├── YaranCore/ScreenPrivacy (inferred)
/// ├── YaranCoreTests/LockTransitionTests (inferred)
/// ├── YaranCoreTests/VaultTests (inferred)
/// ├── YaranSecureStorePlugin/AppLockPlugin (inferred)
/// └── YaranSecureStorePlugin/SecureStorePlugin (inferred)
/// <module-headers:end>

import Foundation
import LocalAuthentication

/// How long the app may sit in the background before the lock engages again.
public enum LockGrace: String, Codable, Sendable, CaseIterable {
    case immediately
    case oneMinute = "1min"
    case fiveMinutes = "5min"
    case fifteenMinutes = "15min"

    public var milliseconds: Int64 {
        switch self {
        case .immediately: return 0
        case .oneMinute: return 60_000
        case .fiveMinutes: return 300_000
        case .fifteenMinutes: return 900_000
        }
    }
}

public enum Biometry: String, Sendable {
    case available
    case noneEnrolled = "none_enrolled"
    case unavailable
}

public struct AppLockStatus: Equatable, Sendable {
    public var enabled: Bool
    public var allowPasscode: Bool
    public var grace: LockGrace
    public var locked: Bool
    public var biometry: Biometry
}

public enum EnableOutcome: String, Sendable { case enabled, cancelled, unavailable }
public enum DisableOutcome: String, Sendable { case disabled, cancelled }
public enum UnlockOutcome: String, Sendable { case unlocked, cancelled, invalidated }

public final class AppLock: @unchecked Sendable {
    public static let shared = AppLock(vault: .shared, biometry: AppLock.probeBiometry)

    private struct Settings: Codable, Equatable {
        var enabled = false
        var allowPasscode = false
        var grace = LockGrace.oneMinute
    }

    private let vault: Vault
    private let biometry: () -> Biometry
    private let mutex = NSRecursiveLock()
    private var settings = Settings()
    /// False while the saved settings could not be read or decoded: see `loadSettings`.
    private var settingsKnown = false
    private var backgroundedAtMs: Int64?
    private var held: ClosedRange<Int64>?
    /// Prompt text shown by the Keychain read; set from the app's localized strings.
    public var prompt = "Unlock yaran"
    /// Posted (any thread) with `userInfo["locked"]: Bool` whenever `locked` changes.
    public static let lockStateChanged = Notification.Name("io.github.siavz.yaran.lockStateChanged")
    public private(set) var locked = false

    public init(vault: Vault, biometry: @escaping () -> Biometry) {
        self.vault = vault
        self.biometry = biometry
        loadSettings()
        locked = settings.enabled // no notification from init: nothing can observe this instance yet
    }

    /// Reads the saved settings. None saved is a first install: the defaults, lock off. Saved but
    /// unreadable or undecodable is not "off": the lock is held engaged on provisional settings
    /// that are never saved, no key copy is recovered or dropped (a staged copy may be the only
    /// one), and every unlock or change reads them again first (`requireSettings`).
    @discardableResult
    private func loadSettings() -> Bool {
        do {
            if let data = try vault.readMeta("applock") {
                settings = try JSONDecoder().decode(Settings.self, from: data)
            } else {
                settings = Settings()
            }
        } catch {
            settingsKnown = false
            settings = Settings()
            settings.enabled = true
            vault.lockEnabled = true
            return false
        }
        settingsKnown = true
        vault.lockEnabled = settings.enabled
        vault.recoverGuard(enabled: settings.enabled, guardKind(settings.allowPasscode))
        return true
    }

    /// Settings that could not be read at start are read again; still unreadable, nothing proceeds.
    private func requireSettings() throws {
        guard !settingsKnown else { return }
        guard loadSettings() else { throw VaultError.unavailable }
    }

    /// The grace rule. A clock that went backwards locks, because that is the safe answer.
    public static func shouldLock(backgroundedAtMs: Int64?, nowMs: Int64, grace: LockGrace) -> Bool {
        guard let backgroundedAtMs else { return false }
        let elapsed = nowMs - backgroundedAtMs
        return elapsed < 0 || elapsed >= grace.milliseconds
    }

    public func status() -> AppLockStatus {
        withLock {
            AppLockStatus(enabled: settings.enabled, allowPasscode: settings.allowPasscode,
                          grace: settings.grace, locked: locked, biometry: biometry())
        }
    }

    public func enable(allowPasscode: Bool) throws -> EnableOutcome {
        try withLock {
            try requireSettings()
            if settings.enabled { return .enabled }
            if biometry() != .available && !allowPasscode { return .unavailable }
            do {
                try vault.guardDataKey(guardKind(allowPasscode), prompt: prompt)
            } catch let failure as KeychainFailure {
                return failure == .cancelled || failure == .authenticationFailed ? .cancelled : .unavailable
            }
            let previous = settings
            settings.enabled = true
            settings.allowPasscode = allowPasscode
            do {
                try save()
            } catch {
                settings = previous
                vault.abandonGuard(guardKind(allowPasscode))
                throw error
            }
            vault.finishGuard()
            setLocked(false)
            return .enabled
        }
    }

    public func disable() throws -> DisableOutcome {
        try withLock {
            try requireSettings()
            guard settings.enabled else { return .disabled }
            do {
                try vault.unguardDataKey(guardKind(settings.allowPasscode), prompt: prompt)
            } catch let failure as KeychainFailure where failure == .cancelled || failure == .authenticationFailed {
                return .cancelled
            } catch let failure as KeychainFailure {
                throw Self.vaultError(failure)
            }
            settings.enabled = false
            do {
                try save()
            } catch {
                settings.enabled = true
                vault.abandonUnguard()
                throw error
            }
            vault.finishUnguard(guardKind(settings.allowPasscode))
            setLocked(false)
            return .disabled
        }
    }

    public func unlock() throws -> UnlockOutcome {
        try withLock {
            try requireSettings()
            guard settings.enabled else {
                setLocked(false)
                return .unlocked
            }
            do {
                try vault.unlock(guardedBy: guardKind(settings.allowPasscode), prompt: prompt)
            } catch VaultError.invalidated {
                try vault.wipeLocked(guardedBy: guardKind(settings.allowPasscode))
                setLocked(false)
                return .invalidated
            } catch let failure as KeychainFailure where failure == .cancelled || failure == .authenticationFailed {
                return .cancelled
            } catch let failure as KeychainFailure {
                throw Self.vaultError(failure)
            }
            setLocked(false)
            return .unlocked
        }
    }

    /// Changing the passcode fallback re-guards the key, which needs the app unlocked. With the lock
    /// on it is a recoverable transition: the key is staged behind the new guard before the setting
    /// is saved, a failed save drops the staged copy, and only then does the main copy change.
    public func setOptions(grace: LockGrace?, allowPasscode: Bool?) throws {
        try withLock {
            try requireSettings()
            let previous = settings
            let reguard = settings.enabled && allowPasscode != nil && allowPasscode != settings.allowPasscode
            if let allowPasscode { settings.allowPasscode = allowPasscode }
            if let grace { settings.grace = grace }
            let kind = guardKind(settings.allowPasscode)
            if reguard {
                do { try vault.stageReguard(kind) } catch let failure as KeychainFailure {
                    settings = previous
                    throw Self.vaultError(failure)
                } catch {
                    settings = previous
                    throw error
                }
            }
            do {
                try save()
            } catch {
                settings = previous
                if reguard { vault.abandonReguard(kind) }
                throw error
            }
            if reguard { vault.finishReguard(kind) }
        }
    }

    /// Engages the lock now (forgets the data key) when it is enabled.
    public func engage() {
        withLock {
            guard settings.enabled else { return }
            vault.engage()
            setLocked(true)
        }
    }

    public func didEnterBackground(nowMs: Int64) {
        withLock { backgroundedAtMs = nowMs }
    }

    /// Engages the lock if the grace period has run out; returns whether it is now locked.
    @discardableResult
    public func willEnterForeground(nowMs: Int64) -> Bool {
        withLock {
            if settings.enabled, held?.contains(nowMs) != true,
               Self.shouldLock(backgroundedAtMs: backgroundedAtMs, nowMs: nowMs, grace: settings.grace) {
                engage()
            }
            backgroundedAtMs = nil
            return locked
        }
    }

    /// A browser sign-in this app launched: coming back within `ttlMs` is not a return from the background.
    public func holdForExternalFlow(ttlMs: Int64, nowMs: Int64) {
        withLock { held = nowMs...(nowMs + ttlMs) }
    }

    /// That sign-in ended (stored, failed, cancelled): the background lock applies again.
    public func releaseExternalFlow() {
        withLock { held = nil }
    }

    /// After `Vault.eraseAll`: back to the defaults, unlocked.
    public func reset() {
        withLock {
            settings = Settings()
            settingsKnown = true
            vault.lockEnabled = false
            setLocked(false)
        }
    }

    // MARK: Internals

    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        mutex.lock(); defer { mutex.unlock() }
        return try body()
    }

    private func guardKind(_ allowPasscode: Bool) -> KeychainGuard {
        allowPasscode ? .userPresence : .biometryCurrentSet
    }

    private func save() throws {
        try vault.writeMeta("applock", JSONEncoder().encode(settings))
    }

    private func setLocked(_ value: Bool) {
        if !value { backgroundedAtMs = nil } // an unlock proves the user is here
        guard value != locked else { return }
        locked = value
        NotificationCenter.default.post(name: Self.lockStateChanged, object: self, userInfo: ["locked": value])
    }

    private static func vaultError(_ failure: KeychainFailure) -> VaultError {
        switch failure {
        case .cancelled, .authenticationFailed, .unavailable, .status: return .unavailable
        }
    }

    /// What LocalAuthentication says about biometrics on this device right now.
    public static func probeBiometry() -> Biometry {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) { return .available }
        return error?.code == LAError.biometryNotEnrolled.rawValue ? .noneEnrolled : .unavailable
    }
}
