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
/// └── MachineViewCoreTests/Fixtures (inferred)
/// External: CryptoKit, Foundation, Testing
///
/// Used by: entry point (Swift Testing, via bash ios/MachineViewCore/test.sh)
/// <module-headers:end>
import CryptoKit
import Foundation
import Testing
@testable import MachineViewCore

@Suite struct CryptoTests {
    @Test func canonicalStringMatchesTheProtocol() {
        let fx = Fixtures.proto("fixtures/sig/handoff-device-signature.json")
        let s = HandoffSignature.canonical(host: fx["host"] as! String, pk: fx["pk"] as! String, state: fx["state"] as! String,
                                           dts: Int64(fx["dts"] as! String)!)
        #expect(s == fx["canonical_utf8"] as! String)
        #expect(Data(s.utf8).hex == fx["canonical_hex"] as! String)
    }

    @Test func committedSignaturesVerify() throws {
        let fx = Fixtures.proto("fixtures/sig/handoff-device-signature.json")
        for c in Fixtures.cases(fx) {
            guard let verified = (c["expect"] as! [String: Any])["verified"] as? Bool else { continue }
            let f = c["fields"] as! [String: String]
            let point = try #require(P256Point.decode(f["dk"]!))
            let key = try P256.Signing.PublicKey(x963Representation: point)
            let raw = try #require(B64url.decode(f["dsig"]!))
            let msg = HandoffSignature.canonical(host: f["host"]!, pk: f["pk"]!, state: f["state"]!, dts: Int64(f["dts"]!)!)
            let sig = try P256.Signing.ECDSASignature(derRepresentation: HandoffSignature.rawToDer(raw))
            #expect(key.isValidSignature(sig, for: Data(msg.utf8)) == verified, "\(c["name"]!)")
        }
    }

    @Test func derCases() {
        for c in Fixtures.cases(Fixtures.plugin("der-signatures.json")) {
            let der = Data(hex: c["der_hex"] as! String)
            if c["error"] as? Bool == true {
                #expect(throws: HandoffSignatureError.malformedDer) { try HandoffSignature.derToRaw(der) }
            } else {
                let raw = try? HandoffSignature.derToRaw(der)
                #expect(raw.map(B64url.encode) == c["raw_b64url"] as? String, "\(c["name"]!)")
                #expect(raw.map(HandoffSignature.rawToDer) == der, "\(c["name"]!)")
            }
        }
    }

    @Test func fingerprintCases() throws {
        let fx = Fixtures.proto("fixtures/sig/device-fingerprint.json")
        #expect(HandoffSignature.deviceKeyTag == fx["tag"] as! String)
        for c in Fixtures.cases(fx) {
            let point = try #require(P256Point.decode(c["dk"] as! String))
            #expect(point.hex == c["dk_hex"] as! String)
            let fp24 = HandoffSignature.fingerprint24(point: point)
            #expect(fp24 == c["fp24"] as! String)
            #expect(HandoffSignature.displayFingerprint(fp24) == c["fingerprint"] as! String)
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
        let g = P256.KeyAgreement.PrivateKey().publicKey.x963Representation
        #expect(P256Point.isOnCurve(x: g.subdata(in: 1..<33), y: g.subdata(in: 33..<65)))
        var bad = g
        bad[64] ^= 1
        #expect(!P256Point.isOnCurve(x: bad.subdata(in: 1..<33), y: bad.subdata(in: 33..<65)))
        #expect(!P256Point.isOnCurve(x: Data(repeating: 0xff, count: 32), y: Data(repeating: 0xff, count: 32)))
        #expect(P256Point.decode(B64url.encode(g)) == g)
    }

    @Test func kdfReproducesRfc7518AppendixC() throws {
        let fx = Fixtures.proto("fixtures/jwe/kdf-rfc7518-appendix-c.json")
        let z = Data(hex: fx["z_hex"] as! String)
        let apu = Data((fx["apu_utf8"] as! String).utf8), apv = Data((fx["apv_utf8"] as! String).utf8)
        let bits = fx["keydatalen"] as! Int
        #expect(ConcatKdf.otherInfo(algorithmId: fx["enc"] as! String, apu: apu, apv: apv, keyBits: bits).hex == fx["other_info_hex"] as! String)
        #expect(ConcatKdf.derive(z: z, algorithmId: fx["enc"] as! String, apu: apu, apv: apv, keyBits: bits).hex == fx["k_hex"] as! String)
        // ECDH of the RFC keys reproduces Z.
        let r = fx["recipient_jwk"] as! [String: String], e = fx["ephemeral_jwk"] as! [String: String]
        let priv = try P256.KeyAgreement.PrivateKey(rawRepresentation: B64url.decode(r["d"]!)!)
        let pub = try P256.KeyAgreement.PublicKey(x963Representation: Data([4]) + B64url.decode(e["x"]!)! + B64url.decode(e["y"]!)!)
        #expect(try priv.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) } == z)
    }

    @Test func jweVectors() throws {
        let vectors = Fixtures.protoDir("fixtures/jwe").filter { $0.0.hasPrefix("handoff-v1-") }
        #expect(vectors.count >= 17)
        for (name, v) in vectors {
            let jwk = v["recipient_jwk"] as! [String: String]
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: B64url.decode(jwk["d"]!)!)
            #expect(B64url.encode(key.publicKey.x963Representation) == v["recipient_pk"] as! String)
            let r = SealedEnvelope.open(jwe: v["compact_jwe"] as! String, recipient: key, expectedHost: v["expected_host"] as! String,
                                        expectedState: v["expected_state"] as! String, expectedKind: v["expected_kind"] as! String,
                                        now: v["now"] as! Int64)
            if let code = v["expect_code"] as? String {
                switch r {
                case .success: Issue.record("\(name) opened but must fail with \(code)")
                case .failure(let e): #expect(e.rawValue == code, "\(name)")
                }
            } else {
                let p = try r.get()
                let want = v["plaintext"] as! [String: Any]
                #expect(p.kind == want["kind"] as! String && p.host == want["host"] as! String, "\(name)")
                #expect(p.jwt == want["jwt"] as! String && p.email == want["email"] as! String, "\(name)")
                #expect(p.exp == want["exp"] as! Int64 && p.iat == want["iat"] as! Int64, "\(name)")
                #expect(p.cookie == want["cookie"] as? String, "\(name)")
                #expect(!String(describing: p).contains(p.jwt))
            }
        }
    }

    @Test func freshRecipientIsInMemoryP256() {
        let (key, pk) = SealedEnvelope.generateRecipient()
        #expect(P256Point.decode(pk) == key.publicKey.x963Representation)
        #expect(Pattern.p256Point.matches(pk))
    }
}
