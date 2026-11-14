//! Tests for the handoff sealer: the shared vectors, the schema fixtures, and a round trip
//! through an independent opener built from the dev-only `p256` and `aes-gcm` crates.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::protocol::handoff`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/handoff_tests.rs
//! ├── cloud::protocol::concat_kdf
//! ├── cloud::protocol::handoff
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: aes_gcm, p256, serde_json
//!
//! Used by:
//! cloud/protocol/handoff_tests.rs
//! └── cloud::protocol::handoff
//! <module-headers:end>

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce as GcmNonce};
use serde_json::Value;

use super::*;
use crate::cloud::protocol::concat_kdf::concat_kdf;
use crate::cloud::protocol::rules::b64url_decode;
use crate::cloud::protocol::test_fixtures::{assert_api_type, fixture, unhex};

#[test]
fn handoff_types_match_the_schema_fixtures() {
    assert_api_type::<HandoffQuery>("HandoffQuery");
    assert_api_type::<HandoffConsent>("HandoffConsent");
    assert_api_type::<HandoffPayload>("HandoffPayload");
}

#[test]
fn seal_with_secret_reproduces_the_shared_vectors() {
    for name in ["machine", "control-plane"] {
        let f = fixture(&format!("jwe/handoff-v1-valid-{name}.json"));
        let recipient = parse_recipient_point(f["recipient_pk"].as_str().unwrap()).unwrap();
        assert_eq!(thumbprint(&recipient), f["kid"], "{name}");
        let iv: [u8; 12] = b64url_decode(f["iv_b64url"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let jwe = seal_with_secret(
            &unhex(f["z_hex"].as_str().unwrap()),
            f["protected_header_json"].as_str().unwrap(),
            &iv,
            f["plaintext_utf8"].as_str().unwrap().as_bytes(),
            f["expected_host"].as_str().unwrap(),
            f["expected_state"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(jwe, f["compact_jwe"], "{name}");
        let payload: HandoffPayload = serde_json::from_value(f["plaintext"].clone()).unwrap();
        payload.validate().unwrap();
    }
}

/// An independent opener: ECDH with the recipient secret, Concat KDF, AES-256-GCM.
fn open(jwe: &str, recipient_d: &[u8]) -> (Value, Vec<u8>) {
    let parts: Vec<&str> = jwe.split('.').collect();
    assert_eq!(parts.len(), 5);
    assert!(parts[1].is_empty(), "encrypted-key part must be empty");
    let header: Value = serde_json::from_slice(&b64url_decode(parts[0]).unwrap()).unwrap();
    let mut epk = vec![4u8];
    epk.extend(b64url_decode(header["epk"]["x"].as_str().unwrap()).unwrap());
    epk.extend(b64url_decode(header["epk"]["y"].as_str().unwrap()).unwrap());
    let secret = p256::SecretKey::from_slice(recipient_d).unwrap();
    let peer = p256::PublicKey::from_sec1_bytes(&epk).unwrap();
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
    let apu = b64url_decode(header["apu"].as_str().unwrap()).unwrap();
    let apv = b64url_decode(header["apv"].as_str().unwrap()).unwrap();
    let cek = concat_kdf(
        shared.raw_secret_bytes().as_ref(),
        "A256GCM",
        &apu,
        &apv,
        256,
    );
    let mut ct = b64url_decode(parts[3]).unwrap();
    ct.extend(b64url_decode(parts[4]).unwrap());
    let iv = b64url_decode(parts[2]).unwrap();
    let cipher = Aes256Gcm::new_from_slice(&cek).unwrap();
    let nonce = GcmNonce::try_from(iv.as_slice()).unwrap();
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ct,
                aad: parts[0].as_bytes(),
            },
        )
        .expect("the independent opener must authenticate the envelope");
    (header, plaintext)
}

#[test]
fn a_ring_sealed_envelope_opens_with_an_independent_implementation() {
    let f = fixture("jwe/handoff-v1-valid-machine.json");
    let pk = f["recipient_pk"].as_str().unwrap();
    let (host, state) = (
        f["expected_host"].as_str().unwrap(),
        f["expected_state"].as_str().unwrap(),
    );
    let payload: HandoffPayload = serde_json::from_value(f["plaintext"].clone()).unwrap();
    let jwe = seal(pk, host, state, &payload).unwrap();
    let d = b64url_decode(f["recipient_jwk"]["d"].as_str().unwrap()).unwrap();
    let (header, plaintext) = open(&jwe, &d);
    assert_eq!(header["alg"], HANDOFF_ALG);
    assert_eq!(header["enc"], HANDOFF_ENC);
    assert_eq!(header["typ"], HANDOFF_TYP);
    assert_eq!(header["cty"], HANDOFF_CTY);
    assert_eq!(header["kid"], f["kid"]);
    assert_eq!(header["epk"]["crv"], "P-256");
    assert_eq!(
        b64url_decode(header["apu"].as_str().unwrap()).unwrap(),
        host.as_bytes()
    );
    assert_eq!(
        b64url_decode(header["apv"].as_str().unwrap()).unwrap(),
        state.as_bytes()
    );
    let opened: HandoffPayload = serde_json::from_slice(&plaintext).unwrap();
    assert_eq!(opened, payload);
    // Two seals of the same payload differ (fresh ephemeral key and IV each time).
    assert_ne!(seal(pk, host, state, &payload).unwrap(), jwe);
}

#[test]
fn the_sealer_refuses_bad_inputs() {
    let f = fixture("jwe/handoff-v1-valid-machine.json");
    let pk = f["recipient_pk"].as_str().unwrap();
    let (host, state) = (
        f["expected_host"].as_str().unwrap(),
        f["expected_state"].as_str().unwrap(),
    );
    let payload: HandoffPayload = serde_json::from_value(f["plaintext"].clone()).unwrap();
    let mut raw = b64url_decode(pk).unwrap();
    raw[64] ^= 1;
    let off_curve = crate::cloud::protocol::rules::b64url_encode(&raw);
    assert_eq!(
        seal(&off_curve, host, state, &payload),
        Err(HandoffError::RecipientKey)
    );
    assert_eq!(
        seal(pk, "other.example.com", state, &payload),
        Err(HandoffError::HostMismatch)
    );
    let mut huge = payload.clone();
    huge.cookie = Some("c".repeat(4096));
    huge.jwt = format!("a.{}.c", "b".repeat(4000));
    assert_eq!(seal(pk, host, state, &huge), Err(HandoffError::TooLarge));
    assert!(!format!("{payload:?}").contains(&payload.jwt));
}
