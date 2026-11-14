//! The sealed handoff envelope, JWE profile `yaran-handoff+jwe` v1 (Design §8, D8): the
//! machine-side sealer behind `/__yaran/handoff` (Phase 11) and the handoff request types.
//!
//! Sealing is ECDH-ES (P-256, an ephemeral key per envelope) → Concat KDF → AES-256-GCM
//! with the base64url protected header as AAD, serialized as a five-part compact JWE with
//! an empty encrypted-key part. `seal_with_secret` is the deterministic core the shared
//! vectors pin; `seal` draws the ephemeral key and IV from the system CSPRNG. ring can
//! seal but not open (it has no static ECDH), which is exactly yaran's role.
//!
//! - Trust boundary: `pk` comes from a query string and is refused unless it is an
//!   on-curve uncompressed point; the payload carries the Access JWT, a bearer secret, so
//!   `HandoffPayload`'s Debug output redacts it.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/handoff.rs
//! ├── cloud::protocol::concat_kdf
//! ├── cloud::protocol::handoff::tests
//! └── cloud::protocol::rules
//! External: ring, serde, serde_json, std
//!
//! Used by:
//! cloud/protocol/handoff.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::handoff::tests
//! ├── cloud::protocol::handoff_consent
//! ├── cloud::protocol::uri
//! ├── yaran-web::cloud_handoff
//! └── yaran-web::cloud_handoff_request
//! <module-headers:end>

use std::fmt;

use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral};
use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

use super::concat_kdf::concat_kdf;
use super::rules::{self, Checked, Invalid, Validate, b64url_encode, check, check_opt};

pub const HANDOFF_ALG: &str = "ECDH-ES";
pub const HANDOFF_ENC: &str = "A256GCM";
pub const HANDOFF_TYP: &str = "yaran-handoff+jwe";
pub const HANDOFF_CTY: &str = "yaran-handoff+json";
pub const HANDOFF_MAX_PLAINTEXT_BYTES: usize = 6144;
pub const HANDOFF_MAX_JWE_CHARS: usize = 8192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffBuild {
    Release,
    Dev,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffMode {
    Query,
    Fragment,
}

/// W16/Y1 GET query (`v` arrives as a decimal string; coerce before validating).
/// `device` control/bidi refusal and the redirect allowlist are the route's checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffQuery {
    pub v: i64,
    pub pk: String,
    pub state: String,
    pub redirect: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<HandoffBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<HandoffMode>,
    pub device: String,
    pub dk: String,
    pub dts: String,
    pub dsig: String,
}

impl Validate for HandoffQuery {
    fn validate(&self) -> Checked {
        check(self.v >= 1, "v")?;
        check(rules::is_p256_point(&self.pk), "pk")?;
        check(rules::is_state(&self.state), "state")?;
        check(rules::chars_between(&self.redirect, 0, 256), "redirect")?;
        check(rules::chars_between(&self.device, 1, 64), "device")?;
        check(rules::is_p256_point(&self.dk), "dk")?;
        check(rules::is_unix_seconds(&self.dts), "dts")?;
        check(rules::is_ecdsa_sig(&self.dsig), "dsig")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffDecision {
    Continue,
    Cancel,
}

/// W16b/Y1b consent form; `dk` must equal the key the GET recorded with `csrf`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffConsent {
    pub v: i64,
    pub pk: String,
    pub state: String,
    pub redirect: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<HandoffBuild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<HandoffMode>,
    pub device: String,
    pub dk: String,
    pub csrf: String,
    pub decision: HandoffDecision,
}

impl Validate for HandoffConsent {
    fn validate(&self) -> Checked {
        check(self.v >= 1, "v")?;
        check(rules::is_p256_point(&self.pk), "pk")?;
        check(rules::is_state(&self.state), "state")?;
        check(rules::chars_between(&self.redirect, 0, 256), "redirect")?;
        check(rules::chars_between(&self.device, 1, 64), "device")?;
        check(rules::is_p256_point(&self.dk), "dk")?;
        check(rules::is_state(&self.csrf), "csrf")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandoffKind {
    Machine,
    ControlPlane,
}

/// The envelope plaintext (`cty` yaran-handoff+json).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffPayload {
    pub v: i64,
    pub kind: HandoffKind,
    pub host: String,
    /// The `Cf-Access-Jwt-Assertion` value exactly as Access attached it.
    pub jwt: String,
    pub email: String,
    pub exp: i64,
    pub iat: i64,
    /// The raw `CF_Authorization` cookie value, when the request carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
}

impl fmt::Debug for HandoffPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HandoffPayload")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("email", &self.email)
            .field("exp", &self.exp)
            .field("jwt", &"<redacted>")
            .field("cookie", &self.cookie.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

fn is_jwt(s: &str) -> bool {
    let parts: Vec<_> = s.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && rules::is_b64url(p))
}

impl Validate for HandoffPayload {
    fn validate(&self) -> Checked {
        check(self.v == 1, "v")?;
        check(rules::is_hostname(&self.host), "host")?;
        check(
            rules::chars_between(&self.jwt, 1, 4096) && is_jwt(&self.jwt),
            "jwt",
        )?;
        check(rules::is_email(&self.email), "email")?;
        check(self.exp >= 0, "exp")?;
        check(self.iat >= 0, "iat")?;
        check_opt(&self.cookie, |c| rules::chars_between(c, 1, 4096), "cookie")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffError {
    /// `pk` is not an on-curve uncompressed P-256 point.
    RecipientKey,
    /// The payload fails its schema rules.
    Payload(Invalid),
    /// The payload's host is not the sealer's own host.
    HostMismatch,
    /// Plaintext over 6 KiB or envelope over 8192 characters.
    TooLarge,
    /// The system random source or ring failed.
    Crypto,
}

impl fmt::Display for HandoffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RecipientKey => write!(f, "the handoff recipient key is not a valid P-256 point"),
            Self::Payload(e) => write!(f, "the handoff payload is invalid: {e}"),
            Self::HostMismatch => write!(
                f,
                "the handoff payload names a host other than the one sealing it"
            ),
            Self::TooLarge => write!(f, "the handoff envelope exceeds its size limit"),
            Self::Crypto => write!(
                f,
                "the handoff envelope could not be sealed (crypto failure)"
            ),
        }
    }
}

impl std::error::Error for HandoffError {}

/// Decodes and validates the phone's recipient key (`pk`).
pub fn parse_recipient_point(pk: &str) -> Result<[u8; 65], HandoffError> {
    rules::decode_p256_point(pk).ok_or(HandoffError::RecipientKey)
}

/// RFC 7638 JWK thumbprint of a raw point: SHA-256 over `{"crv","kty","x","y"}`.
pub fn thumbprint(point: &[u8; 65]) -> String {
    let canonical = format!(
        r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#,
        b64url_encode(&point[1..33]),
        b64url_encode(&point[33..])
    );
    b64url_encode(digest(&SHA256, canonical.as_bytes()).as_ref())
}

/// The protected header this sealer writes (member order fixed; values are base64url or
/// constants, so no JSON escaping is needed).
pub fn protected_header(recipient: &[u8; 65], epk: &[u8], host: &str, state: &str) -> String {
    format!(
        r#"{{"alg":"{HANDOFF_ALG}","enc":"{HANDOFF_ENC}","typ":"{HANDOFF_TYP}","cty":"{HANDOFF_CTY}","kid":"{}","epk":{{"kty":"EC","crv":"P-256","x":"{}","y":"{}"}},"apu":"{}","apv":"{}"}}"#,
        thumbprint(recipient),
        b64url_encode(&epk[1..33]),
        b64url_encode(&epk[33..65]),
        b64url_encode(host.as_bytes()),
        b64url_encode(state.as_bytes()),
    )
}

/// The deterministic core: seals `plaintext` given the ECDH secret `z`, the exact
/// protected-header JSON, and the IV. `host` and `state` are the KDF's apu and apv.
pub fn seal_with_secret(
    z: &[u8],
    protected_header_json: &str,
    iv: &[u8; 12],
    plaintext: &[u8],
    host: &str,
    state: &str,
) -> Result<String, HandoffError> {
    if plaintext.len() > HANDOFF_MAX_PLAINTEXT_BYTES {
        return Err(HandoffError::TooLarge);
    }
    let cek = concat_kdf(z, HANDOFF_ENC, host.as_bytes(), state.as_bytes(), 256);
    let header_b64 = b64url_encode(protected_header_json.as_bytes());
    let key =
        LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &cek).map_err(|_| HandoffError::Crypto)?);
    let mut buf = plaintext.to_vec();
    let tag = key
        .seal_in_place_separate_tag(
            Nonce::assume_unique_for_key(*iv),
            Aad::from(header_b64.as_bytes()),
            &mut buf,
        )
        .map_err(|_| HandoffError::Crypto)?;
    let jwe = format!(
        "{header_b64}..{}.{}.{}",
        b64url_encode(iv),
        b64url_encode(&buf),
        b64url_encode(tag.as_ref())
    );
    if jwe.len() > HANDOFF_MAX_JWE_CHARS {
        return Err(HandoffError::TooLarge);
    }
    Ok(jwe)
}

/// Seals `payload` to the phone's ephemeral key `pk` for this machine's `host` and the
/// handoff `state`, with a fresh ephemeral key and IV.
pub fn seal(
    pk: &str,
    host: &str,
    state: &str,
    payload: &HandoffPayload,
) -> Result<String, HandoffError> {
    let recipient = parse_recipient_point(pk)?;
    payload.validate().map_err(HandoffError::Payload)?;
    if payload.host != host {
        return Err(HandoffError::HostMismatch);
    }
    let plaintext = serde_json::to_vec(payload).map_err(|_| HandoffError::Crypto)?;
    let rng = SystemRandom::new();
    let ephemeral =
        EphemeralPrivateKey::generate(&ECDH_P256, &rng).map_err(|_| HandoffError::Crypto)?;
    let epk = ephemeral
        .compute_public_key()
        .map_err(|_| HandoffError::Crypto)?;
    let header = protected_header(&recipient, epk.as_ref(), host, state);
    let z = agree_ephemeral(
        ephemeral,
        &UnparsedPublicKey::new(&ECDH_P256, recipient),
        |z| z.to_vec(),
    )
    .map_err(|_| HandoffError::RecipientKey)?;
    let mut iv = [0u8; 12];
    rng.fill(&mut iv).map_err(|_| HandoffError::Crypto)?;
    seal_with_secret(&z, &header, &iv, &plaintext, host, state)
}

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;
