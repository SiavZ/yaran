//! Machine request signing (Design §7): the one canonical string every SIG request signs,
//! and the Ed25519 signer that produces the five `Yaran-*` headers.
//!
//! Machine paths are restricted to `^/v1/machine/[a-z]+$` with no query, so ureq and the
//! Workers URL parser can never disagree about what was signed; the signer refuses any
//! other path. Ed25519 (RFC 8032) is deterministic, so fixed inputs reproduce the shared
//! vectors in `fixtures/sig/machine-request.json` byte for byte.
//!
//! - The private key never leaves the `Ed25519KeyPair`; Phase 09 loads it from the
//!   owner-only credentials file (PKCS#8 v2 from `generate_pkcs8`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/signing.rs
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: ring, std
//!
//! Used by:
//! cloud/protocol/signing.rs
//! ├── cloud::machine_api
//! ├── cloud::protocol
//! ├── cloud::signed_request
//! └── cloud::test_support
//! <module-headers:end>

use std::fmt;

use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::Ed25519KeyPair;

use super::rules::b64url_encode;

pub const MACHINE_SIG_TAG: &str = "yaran-machine-sig-v1";
pub const HEADER_PROTOCOL: &str = "Yaran-Protocol";
pub const HEADER_MACHINE_ID: &str = "Yaran-Machine-Id";
pub const HEADER_TIMESTAMP: &str = "Yaran-Timestamp";
pub const HEADER_NONCE: &str = "Yaran-Nonce";
pub const HEADER_SIGNATURE: &str = "Yaran-Signature";

/// What identifies one machine request, apart from the clock, nonce and body.
#[derive(Debug, Clone, Copy)]
pub struct RequestParts<'a> {
    pub method: &'a str,
    /// The request target exactly as sent; must match `^/v1/machine/[a-z]+$`.
    pub path: &'a str,
    /// The Host header (lowercased and stripped of a port when signed).
    pub host: &'a str,
    pub protocol: u32,
    /// `None` only on the claim route (W4).
    pub machine_id: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SigningError {
    /// The path is not a signable machine path.
    Path(String),
    /// The system random source failed.
    Random,
}

impl fmt::Display for SigningError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Path(p) => write!(
                f,
                "`{p}` is not a signable machine path (expected /v1/machine/<lowercase letters>)"
            ),
            Self::Random => write!(
                f,
                "the system random source failed while drawing a request nonce"
            ),
        }
    }
}

impl std::error::Error for SigningError {}

/// The SIG headers for one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedHeaders {
    pub protocol: String,
    pub machine_id: Option<String>,
    pub timestamp: String,
    pub nonce: String,
    pub signature: String,
}

impl SignedHeaders {
    /// `(name, value)` pairs, `Yaran-Machine-Id` omitted on the claim route.
    pub fn pairs(&self) -> Vec<(&'static str, &str)> {
        let mut out = vec![(HEADER_PROTOCOL, self.protocol.as_str())];
        if let Some(id) = &self.machine_id {
            out.push((HEADER_MACHINE_ID, id.as_str()));
        }
        out.push((HEADER_TIMESTAMP, self.timestamp.as_str()));
        out.push((HEADER_NONCE, self.nonce.as_str()));
        out.push((HEADER_SIGNATURE, self.signature.as_str()));
        out
    }
}

fn is_machine_path(path: &str) -> bool {
    path.strip_prefix("/v1/machine/")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_lowercase()))
}

/// Host as signed: lowercase, port removed.
pub fn signed_host(host: &str) -> String {
    let lower = host.to_ascii_lowercase();
    match lower.rsplit_once(':') {
        Some((name, port)) if port.bytes().all(|b| b.is_ascii_digit()) => name.to_string(),
        _ => lower,
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The canonical string (nine LF-joined lines, no trailing newline).
pub fn canonical_string(
    parts: &RequestParts<'_>,
    timestamp: u64,
    nonce: &str,
    body: &[u8],
) -> Result<String, SigningError> {
    if !is_machine_path(parts.path) {
        return Err(SigningError::Path(parts.path.to_string()));
    }
    Ok([
        MACHINE_SIG_TAG.to_string(),
        parts.method.to_ascii_uppercase(),
        parts.path.to_string(),
        signed_host(parts.host),
        parts.protocol.to_string(),
        parts.machine_id.unwrap_or("-").to_string(),
        timestamp.to_string(),
        nonce.to_string(),
        hex(digest(&SHA256, body).as_ref()),
    ]
    .join("\n"))
}

/// Signs with an explicit timestamp (Unix seconds) and nonce (16 bytes, base64url).
pub fn sign(
    key: &Ed25519KeyPair,
    parts: &RequestParts<'_>,
    timestamp: u64,
    nonce: &str,
    body: &[u8],
) -> Result<SignedHeaders, SigningError> {
    let canonical = canonical_string(parts, timestamp, nonce, body)?;
    Ok(SignedHeaders {
        protocol: parts.protocol.to_string(),
        machine_id: parts.machine_id.map(str::to_string),
        timestamp: timestamp.to_string(),
        nonce: nonce.to_string(),
        signature: b64url_encode(key.sign(canonical.as_bytes()).as_ref()),
    })
}

/// Signs with the current clock and a fresh CSPRNG nonce.
pub fn sign_now(
    key: &Ed25519KeyPair,
    parts: &RequestParts<'_>,
    body: &[u8],
) -> Result<SignedHeaders, SigningError> {
    let mut nonce = [0u8; 16];
    SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| SigningError::Random)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    sign(key, parts, now, &b64url_encode(&nonce), body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::{fixture, unhex};

    #[test]
    fn the_signer_reproduces_the_shared_vectors_byte_for_byte() {
        let f = fixture("sig/machine-request.json");
        let key = Ed25519KeyPair::from_pkcs8(&unhex(f["pkcs8_v2_hex"].as_str().unwrap()))
            .expect("pkcs8 v2");
        let seeded = Ed25519KeyPair::from_seed_unchecked(&unhex(f["seed_hex"].as_str().unwrap()))
            .expect("seed");
        use ring::signature::KeyPair as _;
        assert_eq!(b64url_encode(key.public_key().as_ref()), f["public_key"]);
        assert_eq!(seeded.public_key().as_ref(), key.public_key().as_ref());
        let requests = f["requests"].as_array().unwrap();
        assert_eq!(requests.len(), 3);
        for r in requests {
            let parts = RequestParts {
                method: r["method"].as_str().unwrap(),
                path: r["path"].as_str().unwrap(),
                host: r["host"].as_str().unwrap(),
                protocol: r["protocol"].as_str().unwrap().parse().unwrap(),
                machine_id: r["machine_id"].as_str(),
            };
            let ts: u64 = r["timestamp"].as_str().unwrap().parse().unwrap();
            let body = r["body"].as_str().unwrap().as_bytes();
            let nonce = r["nonce"].as_str().unwrap();
            assert_eq!(
                canonical_string(&parts, ts, nonce, body).unwrap(),
                r["canonical"],
                "{}",
                r["name"]
            );
            let signed = sign(&key, &parts, ts, nonce, body).unwrap();
            assert_eq!(signed.signature, r["signature"], "{}", r["name"]);
            for (name, value) in signed.pairs() {
                assert_eq!(r["headers"][name], value, "{} header {name}", r["name"]);
            }
            assert_eq!(
                signed.pairs().len(),
                r["headers"].as_object().unwrap().len()
            );
        }
        let empty = canonical_string(
            &RequestParts {
                method: "GET",
                path: "/v1/machine/config",
                host: "h",
                protocol: 1,
                machine_id: None,
            },
            0,
            "n",
            b"",
        )
        .unwrap();
        assert!(empty.ends_with(f["empty_body_sha256_hex"].as_str().unwrap()));
    }

    #[test]
    fn only_bare_machine_paths_are_signable() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[7u8; 32]).unwrap();
        for path in [
            "/v1/machine",
            "/v1/machine/",
            "/v1/machine/config?x=1",
            "/v1/machine/Config",
            "/v1/me",
        ] {
            let parts = RequestParts {
                method: "GET",
                path,
                host: "h",
                protocol: 1,
                machine_id: Some("m"),
            };
            assert!(
                matches!(sign(&key, &parts, 1, "n", b""), Err(SigningError::Path(_))),
                "{path}"
            );
        }
        let parts = RequestParts {
            method: "GET",
            path: "/v1/machine/config",
            host: "h",
            protocol: 1,
            machine_id: Some("m"),
        };
        let signed = sign_now(&key, &parts, b"").unwrap();
        assert_eq!(signed.nonce.len(), 22);
        assert_eq!(signed.signature.len(), 86);
    }
}
