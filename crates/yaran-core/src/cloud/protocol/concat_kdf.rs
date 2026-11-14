//! The JWE Concat KDF (RFC 7518 §4.6.2; NIST SP 800-56A single-step KDF over SHA-256),
//! which turns the ECDH secret Z into the handoff envelope's content key.
//!
//! For direct ECDH-ES the AlgorithmID is the `enc` value. Pinned by the RFC 7518
//! Appendix C and RFC 7520 §5.5 vectors in `fixtures/jwe/`.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/concat_kdf.rs
//! External: ring
//!
//! Used by:
//! cloud/protocol/concat_kdf.rs
//! └── cloud::protocol::handoff
//! <module-headers:end>

use ring::digest::{Context, SHA256};

fn length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// OtherInfo = len32(alg) ‖ alg ‖ len32(apu) ‖ apu ‖ len32(apv) ‖ apv ‖ be32(keydatalen).
pub fn other_info(algorithm_id: &str, apu: &[u8], apv: &[u8], key_bits: u32) -> Vec<u8> {
    let mut out = Vec::new();
    length_prefixed(&mut out, algorithm_id.as_bytes());
    length_prefixed(&mut out, apu);
    length_prefixed(&mut out, apv);
    out.extend_from_slice(&key_bits.to_be_bytes());
    out
}

/// Derives `key_bits / 8` bytes from Z (`key_bits` a multiple of 8).
pub fn concat_kdf(z: &[u8], algorithm_id: &str, apu: &[u8], apv: &[u8], key_bits: u32) -> Vec<u8> {
    let info = other_info(algorithm_id, apu, apv, key_bits);
    let mut out = Vec::new();
    for counter in 1..=key_bits.div_ceil(256) {
        let mut ctx = Context::new(&SHA256);
        ctx.update(&counter.to_be_bytes());
        ctx.update(z);
        ctx.update(&info);
        out.extend_from_slice(ctx.finish().as_ref());
    }
    out.truncate((key_bits / 8) as usize);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::{fixture, hex, unhex};

    fn kdf_case(file: &str, expect_key: &str) {
        let f = fixture(file);
        let z = unhex(f["z_hex"].as_str().unwrap());
        let (enc, apu, apv) = (
            f["enc"].as_str().unwrap(),
            f["apu_utf8"].as_str().unwrap(),
            f["apv_utf8"].as_str().unwrap(),
        );
        let bits = f["keydatalen"].as_u64().unwrap() as u32;
        assert_eq!(
            hex(&other_info(enc, apu.as_bytes(), apv.as_bytes(), bits)),
            f["other_info_hex"],
            "{file}"
        );
        assert_eq!(
            hex(&concat_kdf(&z, enc, apu.as_bytes(), apv.as_bytes(), bits)),
            f[expect_key],
            "{file}"
        );
    }

    #[test]
    fn the_rfc_vectors_pass() {
        kdf_case("jwe/kdf-rfc7518-appendix-c.json", "k_hex");
        kdf_case("jwe/kdf-rfc7520-5.5.json", "cek_hex");
    }
}
