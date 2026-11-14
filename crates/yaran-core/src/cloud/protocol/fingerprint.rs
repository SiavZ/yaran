//! Key fingerprints a person compares by eye (Design §7.1, §8.1).
//!
//! digest = SHA-256(tag ‖ raw key); the first 15 bytes (120 bits) in RFC 4648 base32 give
//! 24 characters, shown as six dash-joined groups of four. The machine key uses the tag
//! `"yaran-machine-key-v1\n"` over its 32 bytes (printed by the CLI, TUI and web login
//! dialog, Phase 09); the device key reuses the construction (`handoff_consent`).
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/fingerprint.rs
//! External: ring
//!
//! Used by:
//! cloud/protocol/fingerprint.rs
//! ├── cloud::protocol
//! └── cloud::protocol::handoff_consent
//! <module-headers:end>

use ring::digest::{SHA256, digest};

pub const MACHINE_KEY_TAG: &str = "yaran-machine-key-v1\n";
const BASE32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32 without padding.
pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in bytes {
        acc = (acc << 8) | u32::from(b);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32[((acc >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// The 24-character undashed fingerprint.
pub fn fingerprint24(tag: &str, key: &[u8]) -> String {
    let mut input = tag.as_bytes().to_vec();
    input.extend_from_slice(key);
    base32(&digest(&SHA256, &input).as_ref()[..15])
}

/// The 29-character display form of a 24-character fingerprint.
pub fn display_fingerprint(fp24: &str) -> String {
    fp24.as_bytes()
        .chunks(4)
        .map(|c| String::from_utf8_lossy(c).into_owned())
        .collect::<Vec<_>>()
        .join("-")
}

/// `MachineKeyFingerprint` of a raw Ed25519 public key.
pub fn machine_key_fingerprint(public_key: &[u8; 32]) -> String {
    display_fingerprint(&fingerprint24(MACHINE_KEY_TAG, public_key))
}

/// Case-insensitive comparison of a typed fingerprint, dashes and spaces optional.
pub fn fingerprints_match(typed: &str, expected: &str) -> bool {
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| *c != '-' && !c.is_whitespace())
            .map(|c| c.to_ascii_uppercase())
            .collect()
    };
    norm(typed) == norm(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::{fixture, hex, unhex};

    #[test]
    fn the_machine_key_fingerprint_fixture_passes() {
        let f = fixture("sig/fingerprint.json");
        assert_eq!(f["tag"], MACHINE_KEY_TAG);
        for c in f["cases"].as_array().unwrap() {
            let key: [u8; 32] = unhex(c["public_key_hex"].as_str().unwrap())
                .try_into()
                .unwrap();
            let mut input = MACHINE_KEY_TAG.as_bytes().to_vec();
            input.extend_from_slice(&key);
            assert_eq!(hex(digest(&SHA256, &input).as_ref()), c["digest_hex"]);
            assert_eq!(fingerprint24(MACHINE_KEY_TAG, &key), c["fp24"]);
            assert_eq!(machine_key_fingerprint(&key), c["fingerprint"]);
        }
    }

    #[test]
    fn a_typed_fingerprint_matches_regardless_of_case_and_dashes() {
        assert!(fingerprints_match("k7qf 3mzd-w2pa", "K7QF-3MZD-W2PA"));
        assert!(!fingerprints_match("K7QF-3MZD-W2PB", "K7QF-3MZD-W2PA"));
    }
}
