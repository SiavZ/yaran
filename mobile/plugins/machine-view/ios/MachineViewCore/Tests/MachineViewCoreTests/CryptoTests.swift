/// Vector tests for the device signature, fingerprint, DER conversion and sealed envelope.
///
/// Reads the protocol's `sig/handoff-device-signature.json`, `sig/device-fingerprint.json` and
/// every `jwe/*.json` vector, plus `fixtures/der-signatures.json`: valid envelopes open to
/// their payload, every invalid one fails with the code it names, and the KDF reproduces
/// RFC 7518 Appendix C.
///
/// - Pure CryptoKit; no keychain.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCoreTests/CryptoTests
/// ├── MachineViewCore/B64url (inferred)
/// ├── MachineViewCore/HandoffSignature (inferred)
/// ├── MachineViewCore/P256Point (inferred)
/// ├── MachineViewCore/Patterns (inferred)
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCoreTests/DirectOwnershipTests (inferred)
/// ├── MachineViewCoreTests/DirectSettleTests (inferred)
/// ├── MachineViewCoreTests/DirectTests (inferred)
/// ├── MachineViewCoreTests/Fixtures (inferred)
/// ├── MachineViewCoreTests/FormatTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import CryptoKit
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct CryptoTests {
    @Test func canonicalStringMatchesTheProtocol() throws {
        let fixture = Fixtures.proto("fixtures/sig/handoff-device-signature.json")
        let dts = try #require((fixture["dts"] as? String).flatMap { Int64($0) })
        let canonical = HandoffSignature.canonical(host: try #require(fixture["host"] as? String), pk: try #require(fixture["pk"] as? String),
                                                   state: try #require(fixture["state"] as? String), dts: dts)
        #expect(canonical == fixture["canonical_utf8"] as? String)
        #expect(Data(canonical.utf8).hex == fixture["canonical_hex"] as? String)
    }

    @Test func committedSignaturesVerify() throws {
        let fixture = Fixtures.proto("fixtures/sig/handoff-device-signature.json")
        for entry in Fixtures.cases(fixture) {
            guard let verified = (try #require(entry["expect"] as? [String: Any]))["verified"] as? Bool else { continue }
            let fields = try #require(entry["fields"] as? [String: String])
            let point = try #require(P256Point.decode(fields["dk"]!))
            let key = try P256.Signing.PublicKey(x963Representation: point)
            let raw = try #require(B64url.decode(fields["dsig"]!))
            let msg = HandoffSignature.canonical(host: fields["host"]!, pk: fields["pk"]!, state: fields["state"]!, dts: Int64(fields["dts"]!)!)
            let sig = try P256.Signing.ECDSASignature(derRepresentation: HandoffSignature.rawToDer(raw))
            #expect(key.isValidSignature(sig, for: Data(msg.utf8)) == verified, "\(entry["name"]!)")
        }
    }

    @Test func derCases() throws {
        for entry in Fixtures.cases(Fixtures.plugin("der-signatures.json")) {
            let der = Data(hex: try #require(entry["der_hex"] as? String))
            if entry["error"] as? Bool == true {
                #expect(throws: HandoffSignatureError.malformedDer) { try HandoffSignature.derToRaw(der) }
            } else {
                let raw = try? HandoffSignature.derToRaw(der)
                #expect(raw.map(B64url.encode) == entry["raw_b64url"] as? String, "\(entry["name"]!)")
                #expect(raw.map(HandoffSignature.rawToDer) == der, "\(entry["name"]!)")
            }
        }
    }

    @Test func fingerprintCases() throws {
        let fixture = Fixtures.proto("fixtures/sig/device-fingerprint.json")
        #expect(HandoffSignature.deviceKeyTag == fixture["tag"] as? String)
        for entry in Fixtures.cases(fixture) {
            let point = try #require((entry["dk"] as? String).flatMap(P256Point.decode))
            #expect(point.hex == entry["dk_hex"] as? String)
            let fp24 = HandoffSignature.fingerprint24(point: point)
            #expect(fp24 == entry["fp24"] as? String)
            #expect(HandoffSignature.displayFingerprint(fp24) == entry["fingerprint"] as? String)
        }
    }

    @Test func signingRoundTripThroughDer() throws {
        let key = P256.Signing.PrivateKey()
        let msg = Data("yaran".utf8)
        let raw = try HandoffSignature.derToRaw(key.signature(for: msg).derRepresentation)
        #expect(raw.count == 64)
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: raw)
        #expect(key.publicKey.isValidSignature(sig, for: msg))
    }

    @Test func onCurveCheck() {
        let point = P256.KeyAgreement.PrivateKey().publicKey.x963Representation
        #expect(P256Point.isOnCurve(x: point.subdata(in: 1..<33), y: point.subdata(in: 33..<65)))
        var bad = point
        bad[64] ^= 1
        #expect(!P256Point.isOnCurve(x: bad.subdata(in: 1..<33), y: bad.subdata(in: 33..<65)))
        #expect(!P256Point.isOnCurve(x: Data(repeating: 0xff, count: 32), y: Data(repeating: 0xff, count: 32)))
        #expect(P256Point.decode(B64url.encode(point)) == point)
    }

    @Test func kdfReproducesRfc7518AppendixC() throws {
        let fixture = Fixtures.proto("fixtures/jwe/kdf-rfc7518-appendix-c.json")
        let sharedSecret = Data(hex: try #require(fixture["z_hex"] as? String))
        let apu = Data(try #require(fixture["apu_utf8"] as? String).utf8), apv = Data(try #require(fixture["apv_utf8"] as? String).utf8)
        let bits = try #require(fixture["keydatalen"] as? Int), enc = try #require(fixture["enc"] as? String)
        #expect(ConcatKdf.otherInfo(algorithmId: enc, apu: apu, apv: apv, keyBits: bits).hex == fixture["other_info_hex"] as? String)
        #expect(ConcatKdf.derive(z: sharedSecret, algorithmId: enc, apu: apu, apv: apv, keyBits: bits).hex == fixture["k_hex"] as? String)
        // ECDH of the RFC keys reproduces Z.
        let recipientJwk = try #require(fixture["recipient_jwk"] as? [String: String])
        let ephemeralJwk = try #require(fixture["ephemeral_jwk"] as? [String: String])
        let priv = try P256.KeyAgreement.PrivateKey(rawRepresentation: B64url.decode(recipientJwk["d"]!)!)
        let pub = try P256.KeyAgreement.PublicKey(x963Representation: Data([4]) + B64url.decode(ephemeralJwk["x"]!)! + B64url.decode(ephemeralJwk["y"]!)!)
        #expect(try priv.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) } == sharedSecret)
    }

    @Test func jweVectors() throws {
        let vectors = Fixtures.protoDir("fixtures/jwe").filter { $0.0.hasPrefix("handoff-v1-") }
        #expect(vectors.count >= 17)
        for (name, vector) in vectors {
            let jwk = try #require(vector["recipient_jwk"] as? [String: String])
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: B64url.decode(jwk["d"]!)!)
            #expect(B64url.encode(key.publicKey.x963Representation) == vector["recipient_pk"] as? String)
            let result = SealedEnvelope.open(jwe: try #require(vector["compact_jwe"] as? String), recipient: key,
                                             expectedHost: try #require(vector["expected_host"] as? String),
                                             expectedState: try #require(vector["expected_state"] as? String),
                                             expectedKind: try #require(vector["expected_kind"] as? String), now: try #require(vector["now"] as? Int64))
            if let code = vector["expect_code"] as? String {
                switch result {
                case .success: Issue.record("\(name) opened but must fail with \(code)")
                case .failure(let refusal): #expect(refusal.rawValue == code, "\(name)")
                }
            } else {
                let payload = try result.get()
                let want = try #require(vector["plaintext"] as? [String: Any])
                #expect(payload.kind == want["kind"] as? String && payload.host == want["host"] as? String, "\(name)")
                #expect(payload.jwt == want["jwt"] as? String && payload.email == want["email"] as? String, "\(name)")
                #expect(payload.exp == want["exp"] as? Int64 && payload.iat == want["iat"] as? Int64, "\(name)")
                #expect(payload.cookie == want["cookie"] as? String, "\(name)")
                #expect(!String(describing: payload).contains(payload.jwt))
            }
        }
    }

    @Test func freshRecipientIsInMemoryP256() {
        let (key, recipientKey) = SealedEnvelope.generateRecipient()
        #expect(P256Point.decode(recipientKey) == key.publicKey.x963Representation)
        #expect(Pattern.p256Point.matches(recipientKey))
    }
}
