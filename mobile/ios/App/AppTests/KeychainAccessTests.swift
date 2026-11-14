/// KeychainAccessTests: proves the Vault's Keychain access classes on a real device keychain.
///
/// Hosted in the App (the Keychain needs the app's entitlements). Writes through
/// `Vault` + `SystemKeychainStore`, then reads the item attributes back with
/// `SecItemCopyMatching`: standard namespaces must be `WhenUnlockedThisDeviceOnly` in the
/// app's own group, NSE-shared ones `AfterFirstUnlockThisDeviceOnly` in `group.<bundle id>`,
/// and a corrupted blob must surface as `tampered`.
///
/// - Uses its own `apptests` namespaces and removes what it writes.
///
/// <module-headers:begin>
/// Uses:
/// AppTests/KeychainAccessTests
/// ├── YaranCore/KeychainStore (inferred)
/// └── YaranCore/Vault (inferred)
/// External: Security, XCTest
///
/// Used by: entry point (XCTest, hosted AppTests target of mobile/ios/App/App.xcodeproj)
/// <module-headers:end>

import Security
import XCTest
import YaranCore

final class KeychainAccessTests: XCTestCase {
    private var appGroup: String { "group." + (Bundle.main.bundleIdentifier ?? "") }

    private func attributes(account: String) throws -> [String: Any] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Vault.service,
            kSecAttrAccount as String: account,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        return try XCTUnwrap(result as? [String: Any])
    }

    func testStandardNamespaceIsWhenUnlockedThisDeviceOnly() throws {
        let vault = Vault(store: SystemKeychainStore(), accessGroup: appGroup)
        try vault.set(namespace: "apptests", key: "k", value: "v", protection: .standard)
        defer { try? vault.remove(namespace: "apptests", key: "k") }
        XCTAssertEqual(try vault.get(namespace: "apptests", key: "k"), "v")
        let attrs = try attributes(account: "ns.apptests")
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String, kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
        XCTAssertNotEqual(attrs[kSecAttrAccessGroup as String] as? String, appGroup)
        XCTAssertNotEqual(attrs[kSecAttrSynchronizable as String] as? Bool, true)
    }

    func testSharedNamespaceIsAfterFirstUnlockInAppGroup() throws {
        let vault = Vault(store: SystemKeychainStore(), accessGroup: appGroup)
        try vault.set(namespace: "push-apptests", key: "k", value: "v", protection: .standard)
        defer { try? vault.remove(namespace: "push-apptests", key: "k") }
        let attrs = try attributes(account: "ns.push-apptests")
        XCTAssertEqual(attrs[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        XCTAssertEqual(attrs[kSecAttrAccessGroup as String] as? String, appGroup)
    }

    func testCorruptedBlobIsTampered() throws {
        let vault = Vault(store: SystemKeychainStore(), accessGroup: appGroup)
        try vault.set(namespace: "apptests-t", key: "k", value: "v", protection: .standard)
        defer { try? SystemKeychainStore().delete(KeychainItem(service: Vault.service, account: "ns.apptests-t",
                                                               access: .whenUnlockedThisDeviceOnly)) }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Vault.service,
            kSecAttrAccount as String: "ns.apptests-t",
            kSecUseDataProtectionKeychain as String: true,
        ]
        let update = [kSecValueData as String: Data("garbage".utf8)]
        XCTAssertEqual(SecItemUpdate(query as CFDictionary, update as CFDictionary), errSecSuccess)
        XCTAssertThrowsError(try vault.get(namespace: "apptests-t", key: "k")) { error in
            XCTAssertEqual(error as? VaultError, .tampered)
        }
    }
}
