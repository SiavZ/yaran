//! PKCE (RFC 7636) and the login `state` for the browser pairing flow (D7).
//!
//! The verifier is 32 random bytes in base64url (43 characters, inside RFC 7636's
//! 43–128 range and its unreserved charset); the challenge is `S256` only
//! (base64url of SHA-256 of the verifier). `state` is another 32 random bytes,
//! compared in constant time when the callback arrives.
//!
//! - CSPRNG draws only (`ring::rand::SystemRandom`); no I/O.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/pkce.rs
//! └── cloud::protocol::rules
//! External: ring, std
//!
//! Used by:
//! cloud/pkce.rs
//! ├── cloud
//! ├── cloud::login
//! ├── cloud::loopback
//! └── yaran-core[test cloud_login]
//! <module-headers:end>

use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};

use crate::cloud::protocol::rules::b64url_encode;

/// 32 random bytes, base64url (43 characters).
pub fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| "the system random source failed".to_string())?;
    Ok(b64url_encode(&bytes))
}

/// The `S256` code challenge for `verifier`.
pub fn s256_challenge(verifier: &str) -> String {
    b64url_encode(digest(&SHA256, verifier.as_bytes()).as_ref())
}

/// Constant-time string equality (length is not secret).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// One login attempt's secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl std::fmt::Debug for Pkce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pkce { .. }")
    }
}

impl Pkce {
    pub fn generate() -> Result<Self, String> {
        let verifier = random_token()?;
        Ok(Self {
            challenge: s256_challenge(&verifier),
            verifier,
            state: random_token()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s256_matches_rfc7636_appendix_b() {
        assert_eq!(
            s256_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_and_state_have_the_contract_shape() {
        let p = Pkce::generate().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(
            p.verifier
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
        );
        assert!(crate::cloud::protocol::rules::is_state(&p.state));
        assert!(crate::cloud::protocol::rules::is_b64url_43(&p.challenge));
        assert_ne!(p.verifier, Pkce::generate().unwrap().verifier);
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
