/// Opens the `yaran-handoff+jwe` envelope (Phase 02 §8): ECDH-ES, Concat KDF, A256GCM.
///
/// The phone generates an ephemeral P-256 key per handoff, sends its public half as `pk`, and
/// opens the compact JWE the callback carries, enforcing opener obligations 1-7 in order with
/// the protocol's `jwe_*` codes (five parts, profile parameters, `kid` thumbprint, an explicit
/// on-curve `epk`, `apv` = state in constant time, `apu` = host, AEAD over the transmitted
/// header, then the payload's schema, host, kind and expiry). Pinned by `fixtures/jwe/`.
///
/// - The private key lives in memory only (obligation 8); it is never serialized.
/// - Errors carry only the code, never key material or plaintext.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/SealedEnvelope
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// └── MachineViewCore/Patterns (inferred)
/// External: CryptoKit, Foundation
///
/// Used by:
/// MachineViewCore/SealedEnvelope
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCore/OrgApiClient (inferred)
/// ├── MachineViewCore/SessionStore (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation

public enum HandoffOpenError: String, Error, Equatable {
    case malformed = "jwe_malformed"
    case unsupported = "jwe_unsupported"
    case kidMismatch = "jwe_kid_mismatch"
    case pointInvalid = "jwe_point_invalid"
    case stateMismatch = "jwe_state_mismatch"
    case hostMismatch = "jwe_host_mismatch"
    case decryptFailed = "jwe_decrypt_failed"
    case kindMismatch = "jwe_kind_mismatch"
    case expired = "jwe_expired"
}

/// The JWE plaintext (`HandoffPayload`); `jwt` and `cookie` are credentials, never logged.
public struct HandoffPayload: Equatable, CustomStringConvertible {
    public let kind: String, host: String, jwt: String, email: String
    public let exp: Int64, iat: Int64
    public let cookie: String?
    public var description: String { "HandoffPayload(kind: \(kind), host: \(host), exp: \(exp))" }
}

public enum ConcatKdf {
    public static func otherInfo(algorithmId: String, apu: Data, apv: Data, keyBits: Int) -> Data {
        lp(Data(algorithmId.utf8)) + lp(apu) + lp(apv) + be32(UInt32(keyBits))
    }

    public static func derive(z: Data, algorithmId: String, apu: Data, apv: Data, keyBits: Int) -> Data {
        let info = otherInfo(algorithmId: algorithmId, apu: apu, apv: apv, keyBits: keyBits)
        var out = Data()
        var counter: UInt32 = 1
        while out.count * 8 < keyBits {
            out += Data(SHA256.hash(data: be32(counter) + z + info))
            counter += 1
        }
        return out.prefix(keyBits / 8)
    }

    static func be32(_ n: UInt32) -> Data { Data([UInt8(n >> 24), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)]) }
    static func lp(_ d: Data) -> Data { be32(UInt32(d.count)) + d }
}

public enum SealedEnvelope {
    public static let alg = "ECDH-ES", enc = "A256GCM", typ = "yaran-handoff+jwe", cty = "yaran-handoff+json"
    public static let minRemainingS: Int64 = 60

    /// A fresh in-memory recipient key and its `pk` (base64url of the 65-byte point).
    public static func generateRecipient() -> (key: P256.KeyAgreement.PrivateKey, pk: String) {
        let key = P256.KeyAgreement.PrivateKey()
        return (key, B64url.encode(key.publicKey.x963Representation))
    }

    /// RFC 7638 thumbprint of a 65-byte point.
    public static func thumbprint(point: Data) -> String {
        let x = B64url.encode(point.subdata(in: 1..<33)), y = B64url.encode(point.subdata(in: 33..<65))
        return B64url.encode(Data(SHA256.hash(data: Data("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(x)\",\"y\":\"\(y)\"}".utf8))))
    }

    public static func open(jwe: String, recipient: P256.KeyAgreement.PrivateKey, expectedHost: String,
                            expectedState: String, expectedKind: String, now: Int64) -> Result<HandoffPayload, HandoffOpenError> {
        // 1. Five parts, empty encrypted key, JSON header.
        let parts = jwe.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 5, parts[1].isEmpty else { return .failure(.malformed) }
        let headerB64 = parts[0]
        guard let header = B64url.decode(headerB64).flatMap(jsonObject), let iv = B64url.decode(parts[2]),
              let ct = B64url.decode(parts[3]), let tag = B64url.decode(parts[4]), iv.count == 12, tag.count == 16
        else { return .failure(.malformed) }
        // 2. Profile parameters.
        guard header["alg"] as? String == alg, header["enc"] as? String == enc, header["typ"] as? String == typ,
              header["cty"] as? String == cty else { return .failure(.unsupported) }
        // 3. kid is the thumbprint of this handoff's key.
        guard header["kid"] as? String == thumbprint(point: recipient.publicKey.x963Representation) else {
            return .failure(.kidMismatch)
        }
        // 4. epk is a valid P-256 point.
        guard let epk = header["epk"] as? [String: Any], epk["kty"] as? String == "EC", epk["crv"] as? String == "P-256",
              let x = (epk["x"] as? String).flatMap(B64url.decode), let y = (epk["y"] as? String).flatMap(B64url.decode),
              P256Point.isOnCurve(x: x, y: y) else { return .failure(.pointInvalid) }
        // 5. apv is the stored state (constant time), apu the opened host.
        guard let apv = (header["apv"] as? String).flatMap(B64url.decode), constantTimeEqual(apv, Data(expectedState.utf8))
        else { return .failure(.stateMismatch) }
        guard let apu = (header["apu"] as? String).flatMap(B64url.decode), String(data: apu, encoding: .utf8) == expectedHost
        else { return .failure(.hostMismatch) }
        // 6. ECDH, Concat KDF, AES-256-GCM with the transmitted header as AAD.
        let plaintext: Data
        do {
            let peer = try P256.KeyAgreement.PublicKey(x963Representation: Data([0x04]) + x + y)
            let z = try recipient.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
            let cek = ConcatKdf.derive(z: z, algorithmId: enc, apu: apu, apv: apv, keyBits: 256)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
            plaintext = try AES.GCM.open(box, using: SymmetricKey(data: cek), authenticating: Data(headerB64.utf8))
        } catch {
            return .failure(.decryptFailed)
        }
        // 7. Plaintext schema, host, kind and expiry.
        guard let payload = jsonObject(plaintext).flatMap(validPayload) else { return .failure(.malformed) }
        guard payload.host == expectedHost else { return .failure(.hostMismatch) }
        guard payload.kind == expectedKind else { return .failure(.kindMismatch) }
        guard payload.exp > now + minRemainingS else { return .failure(.expired) }
        return .success(payload)
    }

    static func jsonObject(_ data: Data) -> [String: Any]? {
        guard String(data: data, encoding: .utf8) != nil else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// The HandoffPayload schema, checked in code.
    static func validPayload(_ o: [String: Any]) -> HandoffPayload? {
        let allowed: Set<String> = ["v", "kind", "host", "jwt", "email", "exp", "iat", "cookie"]
        guard Set(o.keys).isSubset(of: allowed), integer(o["v"]) == 1,
              let kind = o["kind"] as? String, kind == "machine" || kind == "control_plane",
              let host = o["host"] as? String, host.utf8.count <= 253, Pattern.hostname.matches(host),
              let jwt = o["jwt"] as? String, jwt.utf8.count <= 4096, Pattern.jwt.matches(jwt),
              let email = o["email"] as? String, validEmail(email),
              let exp = integer(o["exp"]), exp >= 0, let iat = integer(o["iat"]), iat >= 0 else { return nil }
        var cookie: String?
        if let raw = o["cookie"] {
            guard let c = raw as? String, (1...4096).contains(c.count) else { return nil }
            cookie = c
        }
        return HandoffPayload(kind: kind, host: host, jwt: jwt, email: email, exp: exp, iat: iat, cookie: cookie)
    }

    /// A JSON integer (not a boolean, not a fraction).
    public static func integer(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), !CFNumberIsFloatType(n) else { return nil }
        return n.int64Value
    }

    static func validEmail(_ e: String) -> Bool {
        let parts = e.split(separator: "@", omittingEmptySubsequences: false)
        return e.count <= 254 && parts.count == 2 && !parts[0].isEmpty && !parts[1].isEmpty
            && !e.unicodeScalars.contains { $0.properties.isWhitespace || $0.value < 0x20 }
    }
}
