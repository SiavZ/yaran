/// Test support: reads 02's shared fixtures and encrypts test pushes the way the Worker does.
///
/// - `Fixtures.json` resolves `cloud/protocol/fixtures/` from this file's path, so every suite
///   reads the same vectors the Rust, Worker and Android suites read.
/// - `TestEncryptor` is the RFC 8291 sender side, built on the decryptor's own key schedule,
///   used only to produce relay bodies for end-to-end NSE cases.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCoreTests/Fixtures
/// ├── YaranPushCore/Base64URL (inferred)
/// └── YaranPushCore/WebPushDecryptor (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// YaranPushCoreTests/Fixtures
/// ├── YaranPushCoreTests/PushInboxTests (inferred)
/// ├── YaranPushCoreTests/PushPayloadTests (inferred)
/// └── YaranPushCoreTests/WebPushDecryptorTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation
@testable import YaranPushCore

enum Fixtures {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("cloud/protocol/fixtures")

    static func json(_ path: String) throws -> [String: Any] {
        let data = try Data(contentsOf: root.appendingPathComponent(path))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func b64(_ text: Any?) -> Data {
        Base64URL.decode(text as! String)!
    }
}

enum TestEncryptor {
    /// One `aes128gcm` record (rs 4096) for the subscription's public key and auth secret.
    static func encrypt(_ plaintext: Data, uaPublic: P256.KeyAgreement.PublicKey, authSecret: Data) throws -> Data {
        let sender = P256.KeyAgreement.PrivateKey()
        var salt = Data(count: 16)
        for i in 0..<16 { salt[i] = UInt8.random(in: 0...255) }
        let shared = try sender.sharedSecretFromKeyAgreement(with: uaPublic).withUnsafeBytes { Data($0) }
        let asPublic = sender.publicKey.x963Representation
        let (cek, nonce) = WebPushDecryptor.deriveKeys(
            ecdhSecret: shared, authSecret: authSecret, salt: salt, uaPublic: uaPublic.x963Representation, asPublic: asPublic
        )
        let sealed = try AES.GCM.seal(plaintext + [2], using: SymmetricKey(data: cek), nonce: AES.GCM.Nonce(data: nonce))
        return salt + Data([0, 0, 0x10, 0, 65]) + asPublic + sealed.ciphertext + sealed.tag
    }
}
