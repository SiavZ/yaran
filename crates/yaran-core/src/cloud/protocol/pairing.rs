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
//! Uses:
//! cloud/protocol/pairing.rs
//! └── cloud::protocol::rules
//! External: serde
//!
//! Used by:
//! cloud/protocol/pairing.rs
//! └── cloud::protocol
//! <module-headers:end>

use serde::{Deserialize, Serialize};

use super::rules::{self, Checked, Validate, check, check_opt};

/// W2 query string (integers are decimal strings on the wire; coerce before validating).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairAuthorizeQuery {
    pub v: i64,
    pub state: String,
    pub code_challenge: String,
    pub code_challenge_method: String,
    pub machine_pubkey: String,
    pub machine_name: String,
    pub callback: String,
    pub yaran_version: String,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PairDecision {
    Approve,
    Deny,
}

/// W3 form post from the confirm page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairConsent {
    pub request_id: String,
    pub csrf: String,
    pub decision: PairDecision,
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
    Success(PairCallbackSuccess),
    Error(PairCallbackError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairCallbackSuccess {
    pub code: String,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairCallbackError {
    pub error: String,
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
