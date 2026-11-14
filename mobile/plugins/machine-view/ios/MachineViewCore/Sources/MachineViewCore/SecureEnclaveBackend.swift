/// The production `DeviceKeyBackend`: Secure Enclave first, a non-exportable Keychain key otherwise.
///
/// `SecKeyCreateRandomKey` with `kSecAttrTokenIDSecureEnclave` (P-256 only), permanent,
/// application tag `yaran.device.<orgId>`, `AfterFirstUnlockThisDeviceOnly`, access control
/// `.privateKeyUsage` and nothing else (the consent page is the human check, not the key).
/// Without a Secure Enclave (the Simulator, per Phase 02 Risks) the same attributes without the
/// token make a software key that still never leaves the Keychain.
///
/// - Compiled on macOS by `swift build`, exercised on a device or the Simulator only (Keychain
///   entitlements); unit tests use a CryptoKit software backend instead.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/SecureEnclaveBackend
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// └── MachineViewCore/Outcomes (inferred)
/// External: Foundation, Security
///
/// Used by:
/// MachineViewCore/SecureEnclaveBackend
/// └── MachineView/AppServices (inferred)
/// <module-headers:end>
import Foundation
import Security

public enum SecureEnclaveBackendError: Error { case keychain(OSStatus), noKey, signFailed }

public final class SecureEnclaveBackend: DeviceKeyBackend {
    public init() {}

    public func exists(_ alias: String) -> Bool { (try? privateKey(alias)) != nil }

    public func generate(_ alias: String) throws -> SecurityLevel {
        if (try? create(alias, enclave: true)) != nil { return .secureEnclave }
        try create(alias, enclave: false)
        return .software
    }

    public func publicPoint(_ alias: String) throws -> Data {
        guard let pub = SecKeyCopyPublicKey(try privateKey(alias)),
              let raw = SecKeyCopyExternalRepresentation(pub, nil) as Data? else { throw SecureEnclaveBackendError.noKey }
        return raw
    }

    public func signDer(_ alias: String, _ data: Data) throws -> Data {
        guard let sig = SecKeyCreateSignature(try privateKey(alias), .ecdsaSignatureMessageX962SHA256, data as CFData, nil)
        else { throw SecureEnclaveBackendError.signFailed }
        return sig as Data
    }

    public func delete(_ alias: String) {
        SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(alias.utf8),
                       kSecUseDataProtectionKeychain: true] as CFDictionary)
    }

    private func create(_ alias: String, enclave: Bool) throws {
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                           enclave ? .privateKeyUsage : [], &error) else {
            throw SecureEnclaveBackendError.keychain(errSecParam)
        }
        var attrs: [CFString: Any] = [
            kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits: 256,
            kSecUseDataProtectionKeychain: true,
            kSecPrivateKeyAttrs: [
                kSecAttrIsPermanent: true,
                kSecAttrApplicationTag: Data(alias.utf8),
                kSecAttrIsExtractable: false,
                kSecAttrAccessControl: access,
            ] as [CFString: Any],
        ]
        if enclave { attrs[kSecAttrTokenID] = kSecAttrTokenIDSecureEnclave }
        guard SecKeyCreateRandomKey(attrs as CFDictionary, &error) != nil else {
            throw SecureEnclaveBackendError.keychain(errSecParam)
        }
    }

    private func privateKey(_ alias: String) throws -> SecKey {
        var item: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassKey, kSecAttrApplicationTag: Data(alias.utf8), kSecAttrKeyClass: kSecAttrKeyClassPrivate,
            kSecReturnRef: true, kSecUseDataProtectionKeychain: true,
        ] as CFDictionary, &item)
        guard status == errSecSuccess, let item else { throw SecureEnclaveBackendError.keychain(status) }
        return item as! SecKey
    }
}
