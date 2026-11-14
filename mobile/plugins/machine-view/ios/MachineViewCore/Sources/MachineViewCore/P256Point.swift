/// P-256 points as the wire carries them, with the explicit on-curve check.
///
/// A `P256Point` is base64url of the 65-byte uncompressed SEC1 form. Before any ECDH or
/// signature check the coordinates are verified against y² = x³ − 3x + b (mod p) here, in
/// code, rather than trusting a library import to do it (Phase 02 §8 opener obligation 4).
///
/// - Pure. Small fixed-width big-integer arithmetic (little-endian 32-bit limbs); not
///   constant-time, which is fine because the inputs are public points.
///
/// <module-headers:begin>
/// Uses:
/// MachineViewCore/P256Point
/// └── MachineViewCore/B64url (inferred)
/// External: Foundation
///
/// Used by:
/// MachineViewCore/P256Point
/// ├── MachineViewCore/SealedEnvelope (inferred)
/// ├── MachineViewCoreTests/CryptoTests (inferred)
/// ├── MachineViewCoreTests/Fakes (inferred)
/// ├── MachineViewCoreTests/HandoffClientTests (inferred)
/// └── MachineViewCoreTests/StoreTests (inferred)
/// <module-headers:end>
import Foundation

public enum P256Point {
    static let p = Limbs(hex: "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff")
    static let b = Limbs(hex: "5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b")

    /// True when 0 <= x, y < p and (x, y) is on the curve.
    public static func isOnCurve(x: Data, y: Data) -> Bool {
        guard x.count == 32, y.count == 32 else { return false }
        let X = Limbs(bytes: x), Y = Limbs(bytes: y)
        guard X < p, Y < p else { return false }
        let lhs = (Y * Y) % p
        let x3 = (((X * X) % p) * X) % p
        let threeX = (X * Limbs(3)) % p
        let rhs = ((x3 + p - threeX) % p + b) % p
        return lhs == rhs
    }

    /// The 65 raw bytes of a valid point string, else nil.
    public static func decode(_ text: String) -> Data? {
        guard let raw = B64url.decode(text), raw.count == 65, raw.first == 0x04,
              isOnCurve(x: raw.subdata(in: 1..<33), y: raw.subdata(in: 33..<65)) else { return nil }
        return raw
    }
}

/// Unsigned big integer, little-endian UInt32 limbs, just enough for the curve equation.
struct Limbs: Comparable {
    var w: [UInt32]

    init(_ v: UInt32) { w = [v] }
    init(words: [UInt32]) { w = words; trim() }
    init(bytes: Data) {
        var words = [UInt32](repeating: 0, count: (bytes.count + 3) / 4)
        for (i, byte) in bytes.reversed().enumerated() { words[i / 4] |= UInt32(byte) << (8 * UInt32(i % 4)) }
        self.init(words: words)
    }
    init(hex: String) {
        var data = Data()
        var it = hex.makeIterator()
        while let a = it.next(), let b = it.next() { data.append(UInt8(String([a, b]), radix: 16)!) }
        self.init(bytes: data)
    }

    mutating func trim() { while w.count > 1 && w.last == 0 { w.removeLast() } }

    var bitWidth: Int { w.count * 32 - w.last!.leadingZeroBitCount }
    func bit(_ i: Int) -> Bool { i / 32 < w.count && (w[i / 32] >> UInt32(i % 32)) & 1 == 1 }

    static func < (a: Limbs, b: Limbs) -> Bool {
        if a.w.count != b.w.count { return a.w.count < b.w.count }
        for i in stride(from: a.w.count - 1, through: 0, by: -1) where a.w[i] != b.w[i] { return a.w[i] < b.w[i] }
        return false
    }

    static func + (a: Limbs, b: Limbs) -> Limbs {
        var out = [UInt32](), carry: UInt64 = 0
        for i in 0..<max(a.w.count, b.w.count) {
            let s = UInt64(i < a.w.count ? a.w[i] : 0) + UInt64(i < b.w.count ? b.w[i] : 0) + carry
            out.append(UInt32(truncatingIfNeeded: s)); carry = s >> 32
        }
        if carry > 0 { out.append(UInt32(carry)) }
        return Limbs(words: out)
    }

    /// a - b for a >= b.
    static func - (a: Limbs, b: Limbs) -> Limbs {
        var out = [UInt32](), borrow: Int64 = 0
        for i in 0..<a.w.count {
            var d = Int64(a.w[i]) - Int64(i < b.w.count ? b.w[i] : 0) - borrow
            borrow = d < 0 ? 1 : 0
            if d < 0 { d += 1 << 32 }
            out.append(UInt32(d))
        }
        return Limbs(words: out)
    }

    static func * (a: Limbs, b: Limbs) -> Limbs {
        var out = [UInt32](repeating: 0, count: a.w.count + b.w.count)
        for i in 0..<a.w.count {
            var carry: UInt64 = 0
            for j in 0..<b.w.count {
                let t = UInt64(a.w[i]) * UInt64(b.w[j]) + UInt64(out[i + j]) + carry
                out[i + j] = UInt32(truncatingIfNeeded: t); carry = t >> 32
            }
            out[i + b.w.count] = UInt32(carry)
        }
        return Limbs(words: out)
    }

    /// Binary long division remainder.
    static func % (a: Limbs, m: Limbs) -> Limbs {
        var r = Limbs(0)
        for i in stride(from: a.bitWidth - 1, through: 0, by: -1) {
            r = r + r
            if a.bit(i) { r = r + Limbs(1) }
            if !(r < m) { r = r - m }
        }
        return r
    }
}
