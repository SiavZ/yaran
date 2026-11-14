/// The D24 device signature pieces: canonical string, DER to raw r‖s, device fingerprint.
///
/// The device key signs `yaran-handoff-device-v1\n<host>\n<pk>\n<state>\n<dts>\n` (Phase 02
/// §8.1); the platform signers return DER, which becomes the 64-byte raw form (each integer
/// left-padded to 32 bytes) sent as `dsig`. The fingerprint is SHA-256 over the tag and the
/// 65-byte point, first 15 bytes in base32. Pinned by the protocol's `sig/` fixtures and
/// `fixtures/der-signatures.json`.
///
/// - Pure. DER parsing is strict (minimal lengths, positive integers, no trailing bytes).
///
/// <module-headers:begin>
/// Uses: none
/// External: CryptoKit, Foundation
///
/// Used by:
/// MachineViewCore/HandoffSignature
/// ├── MachineViewCore/DeviceKeyStore (inferred)
/// ├── MachineViewCore/HandoffClient (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import CryptoKit
import Foundation

public enum HandoffSignatureError: Error, Equatable { case malformedDer }

public enum HandoffSignature {
    public static let tag = "yaran-handoff-device-v1"
    public static let deviceKeyTag = "yaran-device-key-v1\n"

    public static func canonical(host: String, pk: String, state: String, dts: Int64) -> String {
        "\(tag)\n\(host)\n\(pk)\n\(state)\n\(dts)\n"
    }

    public static func derToRaw(_ der: Data) throws -> Data {
        let b = [UInt8](der)
        guard b.count >= 8, b[0] == 0x30, b[1] < 0x80, Int(b[1]) == b.count - 2 else { throw HandoffSignatureError.malformedDer }
        var i = 2
        func integer() throws -> Data {
            guard i + 2 <= b.count, b[i] == 0x02 else { throw HandoffSignatureError.malformedDer }
            let len = Int(b[i + 1])
            guard len >= 1, len < 0x80, i + 2 + len <= b.count else { throw HandoffSignatureError.malformedDer }
            var v = Array(b[(i + 2)..<(i + 2 + len)])
            i += 2 + len
            guard v[0] & 0x80 == 0 else { throw HandoffSignatureError.malformedDer }
            if v.count > 1 && v[0] == 0 {
                guard v[1] & 0x80 != 0 else { throw HandoffSignatureError.malformedDer }
                v.removeFirst()
            }
            guard v.count <= 32 else { throw HandoffSignatureError.malformedDer }
            return Data(repeating: 0, count: 32 - v.count) + Data(v)
        }
        let r = try integer(), s = try integer()
        guard i == b.count else { throw HandoffSignatureError.malformedDer }
        return r + s
    }

    public static func rawToDer(_ raw: Data) -> Data {
        func integer(_ d: Data) -> [UInt8] {
            var v = Array(d.drop(while: { $0 == 0 }))
            if v.isEmpty { v = [0] }
            if v[0] & 0x80 != 0 { v.insert(0, at: 0) }
            return [0x02, UInt8(v.count)] + v
        }
        let body = integer(raw.prefix(32)) + integer(raw.suffix(32))
        return Data([0x30, UInt8(body.count)] + body)
    }

    /// The 24-character fingerprint (the consent cookie's `fp24`) of a 65-byte point.
    public static func fingerprint24(point: Data) -> String {
        base32(Data(SHA256.hash(data: Data(deviceKeyTag.utf8) + point)).prefix(15))
    }

    /// `XXXX-XXXX-…`, the 29-character display form.
    public static func displayFingerprint(_ fp24: String) -> String {
        stride(from: 0, to: fp24.count, by: 4).map { i in
            String(fp24.dropFirst(i).prefix(4))
        }.joined(separator: "-")
    }

    static func base32(_ data: Data) -> String {
        let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        var out = "", acc: UInt32 = 0, bits = 0
        for byte in data {
            acc = (acc << 8) | UInt32(byte); bits += 8
            while bits >= 5 { bits -= 5; out.append(alphabet[Int((acc >> UInt32(bits)) & 31)]) }
        }
        if bits > 0 { out.append(alphabet[Int((acc << UInt32(5 - bits)) & 31)]) }
        return out
    }
}
