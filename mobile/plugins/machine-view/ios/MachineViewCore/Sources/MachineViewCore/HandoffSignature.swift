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

    public static func canonical(host: String, pk recipientKey: String, state: String, dts: Int64) -> String {
        "\(tag)\n\(host)\n\(recipientKey)\n\(state)\n\(dts)\n"
    }

    public static func derToRaw(_ der: Data) throws -> Data {
        let bytes = [UInt8](der)
        guard bytes.count >= 8, bytes[0] == 0x30, bytes[1] < 0x80, Int(bytes[1]) == bytes.count - 2 else { throw HandoffSignatureError.malformedDer }
        var offset = 2
        func integer() throws -> Data {
            guard offset + 2 <= bytes.count, bytes[offset] == 0x02 else { throw HandoffSignatureError.malformedDer }
            let len = Int(bytes[offset + 1])
            guard len >= 1, len < 0x80, offset + 2 + len <= bytes.count else { throw HandoffSignatureError.malformedDer }
            var value = Array(bytes[(offset + 2)..<(offset + 2 + len)])
            offset += 2 + len
            guard value[0] & 0x80 == 0 else { throw HandoffSignatureError.malformedDer }
            if value.count > 1 && value[0] == 0 {
                guard value[1] & 0x80 != 0 else { throw HandoffSignatureError.malformedDer }
                value.removeFirst()
            }
            guard value.count <= 32 else { throw HandoffSignatureError.malformedDer }
            return Data(repeating: 0, count: 32 - value.count) + Data(value)
        }
        let sigR = try integer(), sigS = try integer()
        guard offset == bytes.count else { throw HandoffSignatureError.malformedDer }
        return sigR + sigS
    }

    public static func rawToDer(_ raw: Data) -> Data {
        func integer(_ half: Data) -> [UInt8] {
            var bytes = Array(half.drop(while: { $0 == 0 }))
            if bytes.isEmpty { bytes = [0] }
            if bytes[0] & 0x80 != 0 { bytes.insert(0, at: 0) }
            return [0x02, UInt8(bytes.count)] + bytes
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
        stride(from: 0, to: fp24.count, by: 4).map { offset in
            String(fp24.dropFirst(offset).prefix(4))
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
