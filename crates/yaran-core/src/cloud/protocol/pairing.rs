//! Browser pairing (W2/W3, D7): the authorize query yaran opens in the browser, the
//! confirm-page form the Worker receives, and the loopback callback yaran's listener gets.
//!
//! yaran builds `PairAuthorizeQuery` (Phase 09) and parses `PairCallbackQuery` on
//! `http://127.0.0.1:<port>/callback`; `PairConsent` is here so the Worker's and yaran's
//! tests share one definition. All three are closed (`deny_unknown_fields`).
//!
//! - Trust boundary: the callback query arrives from the browser; `state` must be checked
//!   against the pending login by the caller (constant-time), not here.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/protocol/pairing.rs
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: serde
//!
//! Used by:
//! cloud/protocol/pairing.rs
//! ├── cloud::login
//! └── cloud::protocol
//! ```
//! <module-headers:end>

use serde::{Deserialize, Serialize};

use super::rules::{self, Checked, Validate, check, check_opt};

/// W2 query string (integers are decimal strings on the wire; coerce before validating).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairAuthorizeQuery {
    /// The pairing protocol version.
    pub v: i64,
    /// The machine's state value, echoed back to its callback.
    pub state: String,
    /// The PKCE challenge for the verifier the claim will send.
    pub code_challenge: String,
    /// The challenge method; always `S256`.
    pub code_challenge_method: String,
    /// The machine's Ed25519 public key, which signs its later calls.
    pub machine_pubkey: String,
    /// The name the machine asks for.
    pub machine_name: String,
    /// The loopback address the browser is sent back to.
    pub callback: String,
    /// The version of the yaran pairing.
    pub yaran_version: String,
    /// The local port the tunnel will forward to, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_port: Option<i64>,
}

/// `code_challenge_method` is always S256 (RFC 7636).
pub const CODE_CHALLENGE_METHOD: &str = "S256";

/// The loopback callback port when `callback` is `http://127.0.0.1:<1024-65535>/callback`.
pub fn loopback_callback_port(callback: &str) -> Option<u16> {
    let port = callback
        .strip_prefix("http://127.0.0.1:")?
        .strip_suffix("/callback")?;
    if port.starts_with('0')
        || !(4..=5).contains(&port.len())
        || !port.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    port.parse::<u16>().ok().filter(|p| *p >= 1024)
}

impl Validate for PairAuthorizeQuery {
    fn validate(&self) -> Checked {
        check(self.v >= 1, "v")?;
        check(rules::is_state(&self.state), "state")?;
        check(rules::is_b64url_43(&self.code_challenge), "code_challenge")?;
        check(
            self.code_challenge_method == CODE_CHALLENGE_METHOD,
            "code_challenge_method",
        )?;
        check(
            rules::is_ed25519_public_key(&self.machine_pubkey),
            "machine_pubkey",
        )?;
        check(rules::is_machine_name(&self.machine_name), "machine_name")?;
        check(loopback_callback_port(&self.callback).is_some(), "callback")?;
        check(
            rules::chars_between(&self.yaran_version, 1, 40),
            "yaran_version",
        )?;
        check_opt(
            &self.origin_port,
            |p| rules::is_origin_port(*p),
            "origin_port",
        )
    }
}

/// What the person chose on the confirm page.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairDecision {
    /// Pair the machine.
    Approve,
    /// Refuse it.
    Deny,
}

/// W3 form post from the confirm page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairConsent {
    /// The pairing request being answered.
    pub request_id: String,
    /// The token the confirm page was served with.
    pub csrf: String,
    /// What the person chose.
    pub decision: PairDecision,
    /// A machine of theirs this one replaces, when they chose Replace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_machine_id: Option<String>,
}

impl Validate for PairConsent {
    fn validate(&self) -> Checked {
        check(rules::is_uuid(&self.request_id), "request_id")?;
        check(rules::is_state(&self.csrf), "csrf")?;
        check_opt(
            &self.replace_machine_id,
            |id| rules::is_uuid(id),
            "replace_machine_id",
        )
    }
}

/// What W2/W3 redirect to the loopback callback: `?code&state` or `?error&state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PairCallbackQuery {
    /// The pairing was approved.
    Success(PairCallbackSuccess),
    /// It was refused or failed.
    Error(PairCallbackError),
}

/// An approved pairing: the code the machine claims it with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairCallbackSuccess {
    /// The one-time pair code.
    pub code: String,
    /// The machine's state value, echoed back.
    pub state: String,
}

/// A refused or failed pairing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairCallbackError {
    /// The error code.
    pub error: String,
    /// The machine's state value, echoed back.
    pub state: String,
}

impl Validate for PairCallbackQuery {
    fn validate(&self) -> Checked {
        match self {
            Self::Success(s) => {
                check(rules::is_b64url_43(&s.code), "code")?;
                check(rules::is_state(&s.state), "state")
            }
            Self::Error(e) => {
                check(rules::is_error_code(&e.error), "error")?;
                check(rules::is_state(&e.state), "state")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::assert_api_type;

    #[test]
    fn pairing_types_match_the_schema_fixtures() {
        assert_api_type::<PairAuthorizeQuery>("PairAuthorizeQuery");
        assert_api_type::<PairConsent>("PairConsent");
        assert_api_type::<PairCallbackQuery>("PairCallbackQuery");
    }

    #[test]
    fn the_callback_port_must_be_a_registered_one() {
        assert_eq!(
            loopback_callback_port("http://127.0.0.1:53682/callback"),
            Some(53682)
        );
        assert_eq!(
            loopback_callback_port("http://127.0.0.1:1023/callback"),
            None
        );
        assert_eq!(
            loopback_callback_port("http://127.0.0.1:65536/callback"),
            None
        );
        assert_eq!(
            loopback_callback_port("http://127.0.0.1:01024/callback"),
            None
        );
        assert_eq!(
            loopback_callback_port("http://localhost:53682/callback"),
            None
        );
    }
}
