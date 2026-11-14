//! Prepares one signed machine request: serialize the body once, sign exactly those
//! bytes with 02's `cloud::protocol::signing::sign`, and hand back body plus headers.
//!
//! This module builds no canonical string of its own; 02's shared vectors pin the
//! result. Because the body is serialized exactly once and the same bytes are both
//! signed and sent, a body re-serialized after signing cannot slip through.
//!
//! - Pure apart from the clock and CSPRNG nonce in `prepare`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/signed_request.rs
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::signing
//! ├── cloud::protocol::test_fixtures
//! └── cloud::test_support
//! External: ring, serde, serde_json
//!
//! Used by:
//! cloud/signed_request.rs
//! ├── cloud
//! └── cloud::machine_api
//! <module-headers:end>

use ring::signature::Ed25519KeyPair;
use serde::Serialize;

use crate::cloud::protocol::signing::{self, RequestParts, SignedHeaders, SigningError};

/// The exact bytes to send and the SIG headers that cover them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedRequest {
    pub body: Vec<u8>,
    pub headers: SignedHeaders,
}

/// The body bytes for `value` (`None`: an empty body).
pub fn body_bytes<T: Serialize>(value: Option<&T>) -> Vec<u8> {
    value
        .map(|v| serde_json::to_vec(v).expect("wire types always serialize"))
        .unwrap_or_default()
}

/// Sign `body` now, with a fresh nonce.
pub fn prepare(
    key: &Ed25519KeyPair,
    parts: &RequestParts<'_>,
    body: Vec<u8>,
) -> Result<SignedRequest, SigningError> {
    let headers = signing::sign_now(key, parts, &body)?;
    Ok(SignedRequest { body, headers })
}

/// Sign `body` with a fixed timestamp and nonce (tests and vectors).
pub fn prepare_at(
    key: &Ed25519KeyPair,
    parts: &RequestParts<'_>,
    body: Vec<u8>,
    timestamp: u64,
    nonce: &str,
) -> Result<SignedRequest, SigningError> {
    let headers = signing::sign(key, parts, timestamp, nonce, &body)?;
    Ok(SignedRequest { body, headers })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::machine::RotateRequest;
    use crate::cloud::protocol::test_fixtures::{fixture, unhex};
    use crate::cloud::test_support::RecordedRequest;
    use ring::signature::KeyPair;

    #[test]
    fn prepared_requests_match_the_shared_vectors_byte_for_byte() {
        let f = fixture("sig/machine-request.json");
        let key = Ed25519KeyPair::from_pkcs8(&unhex(f["pkcs8_v2_hex"].as_str().unwrap())).unwrap();
        for r in f["requests"].as_array().unwrap() {
            let parts = RequestParts {
                method: r["method"].as_str().unwrap(),
                path: r["path"].as_str().unwrap(),
                host: r["host"].as_str().unwrap(),
                protocol: r["protocol"].as_str().unwrap().parse().unwrap(),
                machine_id: r["machine_id"].as_str(),
            };
            let signed = prepare_at(
                &key,
                &parts,
                r["body"].as_str().unwrap().as_bytes().to_vec(),
                r["timestamp"].as_str().unwrap().parse().unwrap(),
                r["nonce"].as_str().unwrap(),
            )
            .unwrap();
            for (name, value) in signed.headers.pairs() {
                assert_eq!(r["headers"][name], value, "{} {name}", r["name"]);
            }
        }
    }

    #[test]
    fn a_body_reserialized_after_signing_fails_verification() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[9u8; 32]).unwrap();
        let parts = RequestParts {
            method: "POST",
            path: "/v1/machine/rotate",
            host: "cloud.example.com",
            protocol: 1,
            machine_id: Some("m"),
        };
        let req = RotateRequest {
            known_token_version: 1,
            reason: crate::cloud::protocol::machine::RotateReason::User,
        };
        let signed = prepare(&key, &parts, body_bytes(Some(&req))).unwrap();
        let mut recorded = RecordedRequest {
            method: "POST".into(),
            path: parts.path.into(),
            headers: signed
                .headers
                .pairs()
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .chain([("Host".to_string(), parts.host.to_string())])
                .collect(),
            body: signed.body.clone(),
            ..Default::default()
        };
        let public = key.public_key().as_ref().to_vec();
        assert!(recorded.signature_verifies(&public));
        recorded.body = serde_json::to_vec_pretty(&req).unwrap();
        assert!(!recorded.signature_verifies(&public));
        assert!(body_bytes::<RotateRequest>(None).is_empty());
    }
}
