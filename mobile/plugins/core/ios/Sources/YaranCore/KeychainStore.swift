/// KeychainStore: the small seam between the Vault and the iOS Keychain.
///
/// The Vault reads and writes whole generic-password items through this protocol, so its
/// logic runs under `swift test` against `InMemoryKeychainStore`, while the app uses
/// `SystemKeychainStore` (Security framework). The hosted AppTests read the real attributes
/// back to prove the access classes.
///
/// - `KeychainItem` names one item: service, account, access class, optional access group and
///   optional user-presence guard.
/// - Errors are `KeychainFailure`: cancelled, authentication failed, unavailable, or a raw status.
///
/// <module-headers:begin>
/// Uses: none
/// External: Foundation, LocalAuthentication, Security
///
/// Used by:
/// YaranCore/KeychainStore
/// ├── AppTests/KeychainAccessTests (inferred)
/// ├── YaranCore/AppLock (inferred)
/// ├── YaranCore/Vault (inferred)
/// ├── YaranCoreTests/PluginArgumentsTests (inferred)
/// └── YaranCoreTests/VaultTests (inferred)
/// <module-headers:end>

import Foundation
import LocalAuthentication
import Security

/// Which Keychain access class an item uses.
public enum KeychainAccess: Sendable, Equatable {
    /// `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: the default for the app's own items.
    case whenUnlockedThisDeviceOnly
    /// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: items the push NSE must reach.
    case afterFirstUnlockThisDeviceOnly
    /// `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`: the guarded lock key only.
    case whenPasscodeSetThisDeviceOnly
}

/// The user-presence guard on the lock key.
public enum KeychainGuard: Sendable, Equatable {
    /// `SecAccessControl(.biometryCurrentSet)`: re-enrolling biometrics invalidates the item.
    case biometryCurrentSet
    /// `SecAccessControl(.userPresence)`: biometrics with the device passcode as fallback.
    case userPresence
}

public struct KeychainItem: Sendable, Equatable {
    public var service: String
    public var account: String
    public var access: KeychainAccess
    public var accessGroup: String?
    public var guardedBy: KeychainGuard?

    public init(service: String, account: String, access: KeychainAccess,
                accessGroup: String? = nil, guardedBy: KeychainGuard? = nil) {
        self.service = service
        self.account = account
        self.access = access
        self.accessGroup = accessGroup
        self.guardedBy = guardedBy
    }
}

public enum KeychainFailure: Error, Equatable {
    case cancelled
    case authenticationFailed
    case unavailable
    case status(OSStatus)
}

public protocol KeychainStore: AnyObject, Sendable {
    /// Returns the item's data, or nil when it does not exist. A guarded read shows `prompt`.
    func read(_ item: KeychainItem, prompt: String?) throws -> Data?
    /// Replaces the item (delete then add, so the access class and guard always match `item`).
    func write(_ data: Data, to item: KeychainItem) throws
    /// Deletes the item; deleting a missing item is not an error.
    func delete(_ item: KeychainItem) throws
    /// Every account stored under `service`, in any access group the app may read.
    func accounts(service: String) throws -> [String]
}

/// A process-local store for tests and previews. Guards are recorded but never prompt.
public final class InMemoryKeychainStore: KeychainStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: (item: KeychainItem, data: Data)] = [:]
    /// Set by tests to make the next guarded read behave like the real Keychain would.
    public var guardedReadFailure: KeychainFailure?

    public init() {}

    private func slot(_ service: String, _ account: String) -> String { service + "\u{0}" + account }

    public func read(_ item: KeychainItem, prompt: String?) throws -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let stored = items[slot(item.service, item.account)] else { return nil }
        if stored.item.guardedBy != nil, let failure = guardedReadFailure { throw failure }
        return stored.data
    }

    public func write(_ data: Data, to item: KeychainItem) throws {
        lock.lock(); defer { lock.unlock() }
        items[slot(item.service, item.account)] = (item, data)
    }

    public func delete(_ item: KeychainItem) throws {
        lock.lock(); defer { lock.unlock() }
        items[slot(item.service, item.account)] = nil
    }

    public func accounts(service: String) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        return items.values.filter { $0.item.service == service }.map(\.item.account).sorted()
    }

    /// Test hook: the stored item (attributes included) for an account.
    public func stored(service: String, account: String) -> KeychainItem? {
        lock.lock(); defer { lock.unlock() }
        return items[slot(service, account)]?.item
    }

    /// Test hook: overwrite an item's bytes in place, keeping its attributes.
    public func corrupt(service: String, account: String, with data: Data) {
        lock.lock(); defer { lock.unlock() }
        if let stored = items[slot(service, account)] { items[slot(service, account)] = (stored.item, data) }
    }

    /// Test hook: drop an item the way a biometric re-enrolment does.
    public func drop(service: String, account: String) {
        lock.lock(); defer { lock.unlock() }
        items[slot(service, account)] = nil
    }
}

/// The real Keychain (data-protection keychain, generic-password class).
public final class SystemKeychainStore: KeychainStore, @unchecked Sendable {
    public init() {}

    private func baseQuery(_ service: String, _ account: String?, _ group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    public func read(_ item: KeychainItem, prompt: String?) throws -> Data? {
        var query = baseQuery(item.service, item.account, item.accessGroup)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        if item.guardedBy != nil {
            let context = LAContext()
            context.localizedReason = prompt ?? ""
            query[kSecUseAuthenticationContext as String] = context
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess: return result as? Data
        case errSecItemNotFound: return nil
        default: throw Self.failure(status)
        }
    }

    public func write(_ data: Data, to item: KeychainItem) throws {
        try delete(item)
        var query = baseQuery(item.service, item.account, item.accessGroup)
        query[kSecValueData as String] = data
        let access = Self.accessAttribute(item.access)
        if let guardedBy = item.guardedBy {
            let flags: SecAccessControlCreateFlags = guardedBy == .biometryCurrentSet ? .biometryCurrentSet : .userPresence
            guard let control = SecAccessControlCreateWithFlags(nil, access, flags, nil) else {
                throw KeychainFailure.unavailable
            }
            query[kSecAttrAccessControl as String] = control
        } else {
            query[kSecAttrAccessible as String] = access
        }
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw Self.failure(status) }
    }

    public func delete(_ item: KeychainItem) throws {
        let status = SecItemDelete(baseQuery(item.service, item.account, item.accessGroup) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure(status) }
    }

    public func accounts(service: String) throws -> [String] {
        var query = baseQuery(service, nil, nil)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        // Listing attributes must never trigger the guarded item's prompt.
        let context = LAContext()
        context.interactionNotAllowed = true
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            let rows = result as? [[String: Any]] ?? []
            return rows.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
        case errSecItemNotFound: return []
        default: throw Self.failure(status)
        }
    }

    private static func accessAttribute(_ access: KeychainAccess) -> CFString {
        switch access {
        case .whenUnlockedThisDeviceOnly: return kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        case .afterFirstUnlockThisDeviceOnly: return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        case .whenPasscodeSetThisDeviceOnly: return kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        }
    }

    private static func failure(_ status: OSStatus) -> KeychainFailure {
        switch status {
        case errSecUserCanceled: return .cancelled
        case errSecAuthFailed: return .authenticationFailed
        case errSecInteractionNotAllowed, errSecNotAvailable, errSecMissingEntitlement: return .unavailable
        default: return .status(status)
        }
    }
}
