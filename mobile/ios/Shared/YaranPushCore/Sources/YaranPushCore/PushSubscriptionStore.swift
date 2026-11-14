/// Per-org push subscriptions in the App Group keychain: the P-256 key, the auth secret, the
/// relay registration id, the minted endpoint and its key id.
///
/// The app mints and updates entries; the NSE and the background handler find one by the
/// relay's `r` (the registration id), so orgs can never decrypt each other's pushes and
/// removing an org deletes exactly its keys.
///
/// - Items are generic passwords in the app group's access group with
///   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`: reachable in the background after the
///   first unlock, never migrated through a backup. Before the first unlock the NSE finds
///   nothing and the generic alert stays (accepted, documented).
/// - `KeychainBackend` is the seam the tests swap for an in-memory store; the access-group
///   round trip needs an entitled test host (Xcode), which this package cannot provide.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCore/PushSubscriptionStore
/// └── YaranPushCore/Base64URL (inferred)
/// External: CryptoKit, Foundation, Security
///
/// Used by:
/// YaranPushCore/PushSubscriptionStore
/// ├── NotificationService/NotificationService (inferred)
/// ├── PushPlugin/NotificationRouter+Push (inferred)
/// ├── PushPlugin/PushPlugin (inferred)
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCoreTests/PushInboxTests (inferred)
/// ├── YaranPushRegistration/DeviceRegistrar (inferred)
/// └── YaranPushRegistrationTests/RegistrationTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation
import Security

public struct PushSubscription: Codable, Equatable, Sendable {
    public let orgId: String
    public let registrationId: String
    public let privateKey: Data
    public let authSecret: Data
    /// The relay endpoint (a capability; never leaves native code).
    public var endpoint: String?
    /// The relay's `endpoint_key_id` the endpoint was minted under.
    public var endpointKeyId: String?
    /// The org VAPID key the endpoint is bound to.
    public var vapidPublicKey: String?
    /// The APNs token the endpoint was minted for; a new token means a new endpoint.
    public var transportToken: String?

    public func agreementKey() throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: privateKey)
    }

    /// 02 `PushWebpush.keys.p256dh`.
    public func p256dh() throws -> String {
        Base64URL.encode(try agreementKey().publicKey.x963Representation)
    }

    public var auth: String { Base64URL.encode(authSecret) }
}

public protocol KeychainBackend: Sendable {
    func set(account: String, data: Data) throws
    func get(account: String) throws -> Data?
    func delete(account: String) throws
    func all() throws -> [Data]
}

public struct KeychainError: Error, Equatable {
    public let status: OSStatus
}

public struct PushSubscriptionStore: Sendable {
    let backend: KeychainBackend

    public init(backend: KeychainBackend) {
        self.backend = backend
    }

    /// A fresh key, a 16-byte auth secret and a new registration id for one org; not stored
    /// until `save`, so a failed mint never replaces a working subscription.
    public func mint(orgId: String) throws -> PushSubscription {
        var auth = Data(count: 16)
        let status = auth.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        let subscription = PushSubscription(
            orgId: orgId, registrationId: UUID().uuidString.lowercased(),
            privateKey: P256.KeyAgreement.PrivateKey().rawRepresentation, authSecret: auth
        )
        return subscription
    }

    public func save(_ subscription: PushSubscription) throws {
        try backend.set(account: subscription.orgId, data: JSONEncoder().encode(subscription))
    }

    public func load(orgId: String) throws -> PushSubscription? {
        try backend.get(account: orgId).flatMap { try? JSONDecoder().decode(PushSubscription.self, from: $0) }
    }

    public func delete(orgId: String) throws {
        try backend.delete(account: orgId)
    }

    /// The subscription the relay's `r` names, or nil (the generic alert stays).
    public func find(registrationId: String) throws -> PushSubscription? {
        try backend.all().lazy
            .compactMap { try? JSONDecoder().decode(PushSubscription.self, from: $0) }
            .first { $0.registrationId == registrationId }
    }
}

/// The real backend: App Group keychain items under one service.
public struct SystemKeychain: KeychainBackend {
    let service = "yaran.push.subscription"
    let accessGroup: String

    public init(accessGroup: String) {
        self.accessGroup = accessGroup
    }

    private func base(account: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: accessGroup,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }

    public func set(account: String, data: Data) throws {
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(base(account: account) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(base(account: account).merging(update) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func get(account: String) throws -> Data? {
        var query = base(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(base(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    public func all() throws -> [Data] {
        var query = base(account: nil)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? [Data] ?? []
    }
}

/// Process-local backend for tests and previews.
public final class InMemoryKeychain: KeychainBackend, @unchecked Sendable {
    private var items: [String: Data] = [:]
    private let lock = NSLock()

    public init() {}

    public func set(account: String, data: Data) throws { lock.withLock { items[account] = data } }
    public func get(account: String) throws -> Data? { lock.withLock { items[account] } }
    public func delete(account: String) throws { _ = lock.withLock { items.removeValue(forKey: account) } }
    public func all() throws -> [Data] { lock.withLock { Array(items.values) } }
}
