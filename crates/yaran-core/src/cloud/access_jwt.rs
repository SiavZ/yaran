//! Cloudflare Access application-token verification (Phase 11 §4, D3): the pure check
//! that decides whether a `Cf-Access-Jwt-Assertion` belongs to this machine's paired owner.
//!
//! The checks run in a fixed order and the first failure decides: size and shape, header
//! (`alg` exactly RS256, `kid` present), `kid` known, RSA PKCS#1 v1.5 SHA-256 signature,
//! then `iss`, `aud`, `exp`/`nbf` with skew, `type == "app"`, service-token shape, and
//! finally the owner's email (ASCII case-insensitive). `sub` is deliberately not compared
//! (it changes when the owner is removed and re-added to the account).
//!
//! - Trust boundary: the token is attacker input. It is never logged; `VerifiedAccess`'s
//!   Debug output redacts it.
//! - Pure: the caller supplies the keys and the clock.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/access_jwt.rs
//! ├── cloud::access_jwks
//! ├── cloud::access_jwt::tests
//! ├── cloud::protocol::rules
//! └── cloud::protocol::signals
//! External: ring, serde_json, std
//!
//! Used by:
//! cloud/access_jwt.rs
//! ├── cloud
//! ├── cloud::access_jwt::tests
//! ├── yaran-web::auth::middleware
//! ├── yaran-web::auth::provenance
//! ├── yaran-web::cloud_handoff
//! ├── yaran-web::cloud_ingress
//! └── yaran-web::cloud_ingress_tests
//! ```
//! <module-headers:end>

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde_json::Value;

use super::access_jwks::{Jwks, TeamDomain};
use super::protocol::rules::b64url_decode;
use super::protocol::signals::RefusalCode;

/// Tokens longer than this are refused before any parsing.
pub const MAX_TOKEN_BYTES: usize = 8 * 1024;

/// What a token must match.
#[derive(Debug, Clone)]
pub struct Expectations {
    /// The Access team domain the token must come from.
    pub team: TeamDomain,
    /// The application audience the token must carry.
    pub aud: String,
    /// The paired owner's email, the only one let in.
    pub owner_email: String,
    /// How much clock skew `exp` and `nbf` are given.
    pub skew: Duration,
}

/// A token that passed every check; the request extension handlers read.
#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedAccess {
    /// The signed-in identity's email.
    pub email: String,
    /// The identity's subject id.
    pub sub: String,
    /// The audiences the token names.
    pub aud: Vec<String>,
    /// When it expires.
    pub exp: SystemTime,
    /// The header value verbatim (02's `HandoffPayload.jwt`).
    pub jwt: String,
}

impl std::fmt::Debug for VerifiedAccess {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifiedAccess")
            .field("email", &self.email)
            .field("exp", &self.exp)
            .field("jwt", &"<redacted>")
            .finish_non_exhaustive()
    }
}

/// Why a token was refused; `code()` is the `Yaran-Refusal` value (02 §13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AccessRejection {
    /// No token came with the request.
    Missing,
    /// It does not parse as a JWT.
    Malformed,
    /// It is not signed with RS256.
    BadAlgorithm,
    /// Its key id is not in the team's key set.
    UnknownKid,
    /// Its signature does not verify.
    BadSignature,
    /// It comes from another team.
    WrongIssuer,
    /// It is for another application.
    WrongAudience,
    /// It has expired.
    Expired,
    /// It is not valid yet.
    NotYetValid,
    /// It is not an application token.
    NotAppToken,
    /// It is a service token, which a person's sign-in never is.
    ServiceToken,
    /// It is valid but names someone other than the paired owner.
    NotOwner,
}

impl AccessRejection {
    /// Every rejection, for tests that walk them all.
    pub const ALL: &[AccessRejection] = &[
        Self::Missing,
        Self::Malformed,
        Self::BadAlgorithm,
        Self::UnknownKid,
        Self::BadSignature,
        Self::WrongIssuer,
        Self::WrongAudience,
        Self::Expired,
        Self::NotYetValid,
        Self::NotAppToken,
        Self::ServiceToken,
        Self::NotOwner,
    ];

    /// The refusal code the response carries.
    pub fn refusal(self) -> RefusalCode {
        match self {
            Self::Missing => RefusalCode::AccessMissing,
            Self::Malformed => RefusalCode::AccessMalformed,
            Self::BadAlgorithm => RefusalCode::AccessBadAlgorithm,
            Self::UnknownKid => RefusalCode::AccessUnknownKid,
            Self::BadSignature => RefusalCode::AccessBadSignature,
            Self::WrongIssuer => RefusalCode::AccessWrongIssuer,
            Self::WrongAudience => RefusalCode::AccessWrongAudience,
            Self::Expired => RefusalCode::AccessExpired,
            Self::NotYetValid => RefusalCode::AccessNotYetValid,
            Self::NotAppToken => RefusalCode::AccessNotAppToken,
            Self::ServiceToken => RefusalCode::AccessServiceToken,
            Self::NotOwner => RefusalCode::AccessNotOwner,
        }
    }

    /// That code's wire spelling, the `Yaran-Refusal` value.
    pub fn code(self) -> &'static str {
        self.refusal().as_str()
    }

    /// 401 for everything but `NotOwner` (403).
    pub fn status(self) -> u16 {
        self.refusal().status()
    }
}

fn segment_json(segment: &str) -> Result<Value, AccessRejection> {
    let bytes = b64url_decode(segment).ok_or(AccessRejection::Malformed)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| AccessRejection::Malformed)?;
    value
        .is_object()
        .then_some(value)
        .ok_or(AccessRejection::Malformed)
}

fn unix(secs: f64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs_f64(secs.max(0.0))
}

/// Verifies `token` against `keys` and `expect` at `now` (Phase 11 §4 order).
///
/// # Errors
///
/// Fails with the first [`AccessRejection`] the token breaks.
pub fn verify(
    token: &str,
    keys: &Jwks,
    expect: &Expectations,
    now: SystemTime,
) -> Result<VerifiedAccess, AccessRejection> {
    if token.is_empty() {
        return Err(AccessRejection::Missing);
    }
    if token.len() > MAX_TOKEN_BYTES {
        return Err(AccessRejection::Malformed);
    }
    let parts: Vec<&str> = token.split('.').collect();
    let [header_b64, claims_b64, sig_b64] = parts.as_slice() else {
        return Err(AccessRejection::Malformed);
    };

    let header = segment_json(header_b64)?;
    if header.get("alg").and_then(Value::as_str) != Some("RS256") {
        return Err(AccessRejection::BadAlgorithm);
    }
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .ok_or(AccessRejection::Malformed)?;

    let key = keys.get(kid).ok_or(AccessRejection::UnknownKid)?;
    let sig = b64url_decode(sig_b64).ok_or(AccessRejection::BadSignature)?;
    let signed = &token[..header_b64.len() + 1 + claims_b64.len()];
    RsaPublicKeyComponents {
        n: &key.n,
        e: &key.e,
    }
    .verify(&RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &sig)
    .map_err(|_| AccessRejection::BadSignature)?;

    let claims = segment_json(claims_b64)?;
    let str_claim = |name: &str| claims.get(name).and_then(Value::as_str);
    if str_claim("iss") != Some(expect.team.issuer().as_str()) {
        return Err(AccessRejection::WrongIssuer);
    }
    let aud: Vec<String> = match claims.get("aud") {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|a| a.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    if !aud.contains(&expect.aud) {
        return Err(AccessRejection::WrongAudience);
    }
    let exp = claims
        .get("exp")
        .and_then(Value::as_f64)
        .map(unix)
        .ok_or(AccessRejection::Malformed)?;
    if exp + expect.skew <= now {
        return Err(AccessRejection::Expired);
    }
    if let Some(nbf) = claims.get("nbf") {
        let nbf = nbf.as_f64().map(unix).ok_or(AccessRejection::Malformed)?;
        if nbf > now + expect.skew {
            return Err(AccessRejection::NotYetValid);
        }
    }
    if str_claim("type") != Some("app") {
        return Err(AccessRejection::NotAppToken);
    }

    let email = str_claim("email").unwrap_or_default();
    let sub = str_claim("sub").unwrap_or_default();
    if email.is_empty() || sub.is_empty() || claims.get("common_name").is_some() {
        return Err(AccessRejection::ServiceToken);
    }
    if !email.eq_ignore_ascii_case(&expect.owner_email) {
        return Err(AccessRejection::NotOwner);
    }

    Ok(VerifiedAccess {
        email: email.to_string(),
        sub: sub.to_string(),
        aud,
        exp,
        jwt: token.to_string(),
    })
}

#[cfg(test)]
#[path = "access_jwt_tests.rs"]
mod tests;
