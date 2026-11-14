/// RFC 8291 decryption pinned to RFC 8291 Appendix A and 02's `webpush/payload-vectors.json`,
/// plus the refusals: tampered tag, wrong key, truncated header and out-of-bounds record size.
///
/// - Swift Testing, not XCTest: the Command Line Tools ship no XCTest.framework.
///
/// <module-headers:begin>
/// Uses:
/// YaranPushCoreTests/WebPushDecryptorTests
/// ├── YaranPushCore/WebPushDecryptor (inferred)
/// └── YaranPushCoreTests/Fixtures (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (swift test / Swift Testing, via mobile/ios/Shared/YaranPushCore/test.sh)
/// <module-headers:end>
import CryptoKit
import Foundation
import Testing
@testable import YaranPushCore

@Suite struct WebPushDecryptorTests {
    let appendix: [String: Any]
    let key: P256.KeyAgreement.PrivateKey
    let auth: Data

    init() throws {
        appendix = try Fixtures.json("webpush/rfc8291-appendix-a.json")
        key = try P256.KeyAgreement.PrivateKey(rawRepresentation: Fixtures.b64(appendix["ua_private"]))
        auth = Fixtures.b64(appendix["auth_secret"])
    }

    @Test func rfc8291AppendixA() throws {
        #expect(key.publicKey.x963Representation == Fixtures.b64(appendix["ua_public"]))
        let plain = try WebPushDecryptor.decrypt(body: Fixtures.b64(appendix["body"]), uaPrivate: key, authSecret: auth)
        #expect(plain == Fixtures.b64(appendix["plaintext"]))
    }

    @Test func appendixIntermediateValues() throws {
        let (cek, nonce) = WebPushDecryptor.deriveKeys(
            ecdhSecret: Fixtures.b64(appendix["ecdh_secret"]), authSecret: auth, salt: Fixtures.b64(appendix["salt"]),
            uaPublic: Fixtures.b64(appendix["ua_public"]), asPublic: Fixtures.b64(appendix["as_public"])
        )
        #expect(cek == Fixtures.b64(appendix["cek"]))
        #expect(nonce == Fixtures.b64(appendix["nonce"]))
    }

    @Test func payloadVectors() throws {
        let vectors = try Fixtures.json("webpush/payload-vectors.json")
        let cases = vectors["cases"] as! [[String: Any]]
        #expect(cases.count == 3)
        for vector in cases {
            let body = Fixtures.b64(vector["body_b64url"])
            #expect(body.count == vector["body_bytes"] as! Int)
            let plain = try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
            #expect(plain == Fixtures.b64(vector["plaintext_b64url"]), "\(vector["name"]!)")
        }
    }

    @Test func tamperedTagIsRefused() throws {
        var body = Fixtures.b64(appendix["body"])
        body[body.count - 1] ^= 1
        #expect(throws: WebPushDecryptError.authenticationFailed) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
    }

    @Test func wrongKeyAndWrongAuthAreRefused() throws {
        let body = Fixtures.b64(appendix["body"])
        #expect(throws: WebPushDecryptError.authenticationFailed) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: P256.KeyAgreement.PrivateKey(), authSecret: auth)
        }
        #expect(throws: WebPushDecryptError.authenticationFailed) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: Data(repeating: 7, count: 16))
        }
    }

    @Test func truncatedHeaderIsRefused() throws {
        let body = Fixtures.b64(appendix["body"])
        for length in [0, 20, 21, 85, 86, 100] {
            #expect(throws: WebPushDecryptError.self) {
                try WebPushDecryptor.decrypt(body: body.prefix(length), uaPrivate: key, authSecret: auth)
            }
        }
        #expect(throws: WebPushDecryptError.truncatedHeader) {
            try WebPushDecryptor.decrypt(body: body.prefix(40), uaPrivate: key, authSecret: auth)
        }
    }

    @Test func recordSizeIsBounded() throws {
        var body = Fixtures.b64(appendix["body"])
        body.replaceSubrange(16..<20, with: [0, 0, 0x20, 0]) // 8192
        #expect(throws: WebPushDecryptError.recordSizeOutOfBounds) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
        body.replaceSubrange(16..<20, with: [0, 0, 0, 18]) // smaller than the record: a second record
        #expect(throws: WebPushDecryptError.multipleRecords) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
        body.replaceSubrange(16..<20, with: [0, 0, 0, 16])
        #expect(throws: WebPushDecryptError.recordSizeOutOfBounds) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
    }

    @Test func keyIdMustBeAnUncompressedPoint() throws {
        var body = Fixtures.b64(appendix["body"])
        body[20] = 33
        #expect(throws: WebPushDecryptError.badKeyIdLength) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
        body = Fixtures.b64(appendix["body"])
        body[21] = 0x05 // not an uncompressed point tag
        #expect(throws: WebPushDecryptError.badSenderKey) {
            try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth)
        }
    }

    @Test func roundTripThroughTheTestEncryptor() throws {
        let message = Data("{\"v\":1,\"k\":\"test\",\"ts\":1}".utf8)
        let body = try TestEncryptor.encrypt(message, uaPublic: key.publicKey, authSecret: auth)
        #expect(try WebPushDecryptor.decrypt(body: body, uaPrivate: key, authSecret: auth) == message)
    }
}
