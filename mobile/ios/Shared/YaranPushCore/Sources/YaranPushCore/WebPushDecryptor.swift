/// RFC 8291 `aes128gcm` Web Push decryption on the device (the NSE and the background handler).
///
/// Parses the RFC 8188 header (salt, record size, sender key), derives the shared secret with
/// the subscription's P-256 key, runs the two RFC 8291 HMAC-SHA-256 stages for the content key
/// and nonce, opens the one AES-128-GCM record and strips its padding.
///
/// - Trust boundary: the input is attacker-reachable bytes. Every length is checked before it
///   is read, the record size is bounded, and only a single final record is accepted (yaran
///   payloads are at most 320 bytes; 02 §9).
/// - Any failure is a thrown `WebPushDecryptError`; callers keep the generic alert.
///
/// <module-headers:begin>
/// Uses: none
/// External: CryptoKit, Foundation
///
/// Used by:
/// YaranPushCore/WebPushDecryptor
/// ├── YaranPushCore/PushInbox (inferred)
/// ├── YaranPushCoreTests/Fixtures (inferred)
/// └── YaranPushCoreTests/WebPushDecryptorTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation

public enum WebPushDecryptError: Error, Equatable {
    case truncatedHeader
    case badKeyIdLength
    case recordSizeOutOfBounds
    case multipleRecords
    case badSenderKey
    case authenticationFailed
    case badPadding
}

public enum WebPushDecryptor {
    /// The largest record size accepted; one 4096-byte record holds RFC 8291's 3993-byte ceiling.
    public static let maxRecordSize = 4096
    static let headerFixedLength = 16 + 4 + 1
    static let keyIdLength = 65
    static let tagLength = 16

    /// Decrypts one `aes128gcm` body for the subscription (`uaPrivate`, `authSecret`).
    public static func decrypt(body: Data, uaPrivate: P256.KeyAgreement.PrivateKey, authSecret: Data) throws -> Data {
        let bytes = [UInt8](body)
        guard bytes.count >= headerFixedLength else { throw WebPushDecryptError.truncatedHeader }
        let salt = Data(bytes[0..<16])
        let recordSize = bytes[16..<20].reduce(0) { ($0 << 8) | Int($1) }
        let idLength = Int(bytes[20])
        guard idLength == keyIdLength else { throw WebPushDecryptError.badKeyIdLength }
        guard bytes.count >= headerFixedLength + idLength else { throw WebPushDecryptError.truncatedHeader }
        guard recordSize > tagLength + 1, recordSize <= maxRecordSize else {
            throw WebPushDecryptError.recordSizeOutOfBounds
        }
        let senderKeyBytes = Data(bytes[headerFixedLength..<(headerFixedLength + idLength)])
        let record = Data(bytes[(headerFixedLength + idLength)...])
        guard record.count > tagLength else { throw WebPushDecryptError.truncatedHeader }
        guard record.count <= recordSize else { throw WebPushDecryptError.multipleRecords }

        let senderKey: P256.KeyAgreement.PublicKey
        do {
            senderKey = try P256.KeyAgreement.PublicKey(x963Representation: senderKeyBytes)
        } catch {
            throw WebPushDecryptError.badSenderKey
        }
        let shared = try uaPrivate.sharedSecretFromKeyAgreement(with: senderKey)
        let ecdhSecret = shared.withUnsafeBytes { Data($0) }
        let (cek, nonce) = deriveKeys(
            ecdhSecret: ecdhSecret, authSecret: authSecret, salt: salt,
            uaPublic: uaPrivate.publicKey.x963Representation, asPublic: senderKeyBytes
        )

        let padded: Data
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: nonce),
                ciphertext: record.prefix(record.count - tagLength),
                tag: record.suffix(tagLength)
            )
            padded = try AES.GCM.open(box, using: SymmetricKey(data: cek))
        } catch {
            throw WebPushDecryptError.authenticationFailed
        }
        return try stripPadding(padded)
    }

    /// RFC 8291 §3.3-3.4 and RFC 8188 §2.2: the content key (16 bytes) and nonce (12 bytes).
    static func deriveKeys(ecdhSecret: Data, authSecret: Data, salt: Data, uaPublic: Data, asPublic: Data) -> (Data, Data) {
        let prkKey = hmac(key: authSecret, ecdhSecret)
        let keyInfo = Data("WebPush: info".utf8) + [0] + uaPublic + asPublic
        let ikm = hmac(key: prkKey, keyInfo + [1])
        let prk = hmac(key: salt, ikm)
        let cek = hmac(key: prk, Data("Content-Encoding: aes128gcm".utf8) + [0, 1]).prefix(16)
        let nonce = hmac(key: prk, Data("Content-Encoding: nonce".utf8) + [0, 1]).prefix(12)
        return (Data(cek), Data(nonce))
    }

    static func hmac(key: Data, _ message: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    /// The last record's padding: trailing zeros, then the 0x02 delimiter.
    static func stripPadding(_ padded: Data) throws -> Data {
        guard let delimiter = padded.lastIndex(where: { $0 != 0 }), padded[delimiter] == 2 else {
            throw WebPushDecryptError.badPadding
        }
        return Data(padded[padded.startIndex..<delimiter])
    }
}
