//! The cloud protocol error registry and JSON error envelope (Design §4), machine side.
//!
//! `ErrorCode` lists every HTTP-emittable code in `cloud/protocol/registry/errors.json`
//! (the local `jwe_*`/`push_*`/`uri_invalid` codes are never decoded by Rust), with its
//! status and retryability; a test keeps the two equal. An unknown code decodes to
//! `Unknown`, and callers fall back to the HTTP status class.
//!
//! - `message` is server text already sanitized by the sender; still pass it through
//!   `yaran_core::sanitize` before logging or showing it (it crossed a trust boundary).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/errors.rs
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: serde, serde_json
//!
//! Used by:
//! cloud/protocol/errors.rs
//! ├── cloud::protocol
//! └── cloud::protocol::handoff_consent
//! <module-headers:end>

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::rules::{self, Checked, Validate, check};

macro_rules! error_codes {
    ($($variant:ident => ($code:literal, $status:expr, $retry:literal),)*) => {
        /// A registry error code; `Unknown` is any code this build does not know.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum ErrorCode {
            $($variant,)*
            Unknown,
        }

        impl ErrorCode {
            /// Every known code, in registry order.
            pub const ALL: &[ErrorCode] = &[$(ErrorCode::$variant,)*];

            /// The wire spelling (`"unknown"` for `Unknown`).
            pub fn as_str(self) -> &'static str {
                match self {
                    $(ErrorCode::$variant => $code,)*
                    ErrorCode::Unknown => "unknown",
                }
            }

            /// The registry's HTTP status; `None` for callback-only codes and `Unknown`.
            pub fn status(self) -> Option<u16> {
                match self {
                    $(ErrorCode::$variant => $status,)*
                    ErrorCode::Unknown => None,
                }
            }

            /// Whether the registry marks the code retryable (`false` for `Unknown`; use
            /// [`retryable_status`] for those).
            pub fn is_retryable(self) -> bool {
                match self {
                    $(ErrorCode::$variant => $retry,)*
                    ErrorCode::Unknown => false,
                }
            }

            /// Parses a wire code; anything unlisted is `Unknown`.
            pub fn parse(code: &str) -> ErrorCode {
                match code {
                    $($code => ErrorCode::$variant,)*
                    _ => ErrorCode::Unknown,
                }
            }
        }
    };
}

error_codes! {
    BadRequest => ("bad_request", Some(400), false),
    ValidationFailed => ("validation_failed", Some(400), false),
    ProtocolUnsupported => ("protocol_unsupported", Some(400), false),
    Unauthenticated => ("unauthenticated", Some(401), false),
    ServiceTokenRejected => ("service_token_rejected", Some(403), false),
    Forbidden => ("forbidden", Some(403), false),
    UserDisabled => ("user_disabled", Some(403), false),
    DeviceRevoked => ("device_revoked", Some(403), false),
    OriginMismatch => ("origin_mismatch", Some(403), false),
    MisdirectedHost => ("misdirected_host", Some(421), false),
    NotFound => ("not_found", Some(404), false),
    MethodNotAllowed => ("method_not_allowed", Some(405), false),
    Conflict => ("conflict", Some(409), false),
    PayloadTooLarge => ("payload_too_large", Some(413), false),
    UnsupportedMediaType => ("unsupported_media_type", Some(415), false),
    RateLimited => ("rate_limited", Some(429), true),
    Internal => ("internal", Some(500), true),
    CloudflareApiFailed => ("cloudflare_api_failed", Some(502), true),
    CloudflareUnavailable => ("cloudflare_unavailable", Some(502), true),
    CloudflareRateLimited => ("cloudflare_rate_limited", Some(503), true),
    CloudflarePermissionDenied => ("cloudflare_permission_denied", Some(502), false),
    Unavailable => ("unavailable", Some(503), true),
    IdentityUnavailable => ("identity_unavailable", Some(503), true),
    SetupIncomplete => ("setup_incomplete", Some(503), false),
    SetupClosed => ("setup_closed", Some(410), false),
    SetupCodeInvalid => ("setup_code_invalid", Some(401), false),
    SetupLocked => ("setup_locked", Some(403), false),
    SetupClaimInvalid => ("setup_claim_invalid", Some(403), false),
    SignatureMissing => ("signature_missing", Some(401), false),
    SignatureInvalid => ("signature_invalid", Some(401), false),
    SignatureExpired => ("signature_expired", Some(401), false),
    NonceReplayed => ("nonce_replayed", Some(401), false),
    MachineUnknown => ("machine_unknown", Some(401), false),
    MachineRevoked => ("machine_revoked", Some(410), false),
    MachineNotReady => ("machine_not_ready", Some(409), true),
    PairingNotAllowed => ("pairing_not_allowed", Some(403), false),
    PairRequestInvalid => ("pair_request_invalid", Some(400), false),
    PairCallbackInvalid => ("pair_callback_invalid", Some(400), false),
    PairDenied => ("pair_denied", Some(403), false),
    PairRequestExpired => ("pair_request_expired", Some(410), false),
    PairCodeInvalid => ("pair_code_invalid", Some(400), false),
    PkceMismatch => ("pkce_mismatch", Some(400), false),
    MachineNameInvalid => ("machine_name_invalid", Some(400), false),
    MachineCapReached => ("machine_cap_reached", Some(409), false),
    AccountQuotaReached => ("account_quota_reached", Some(409), false),
    HostnameConflict => ("hostname_conflict", Some(409), false),
    ProvisioningInProgress => ("provisioning_in_progress", Some(409), true),
    ProvisioningFailed => ("provisioning_failed", Some(502), true),
    TunnelDeleteBlocked => ("tunnel_delete_blocked", Some(502), true),
    OriginPortInvalid => ("origin_port_invalid", Some(400), false),
    HandoffRequestInvalid => ("handoff_request_invalid", Some(400), false),
    HandoffDeclined => ("handoff_declined", None, false),
    HandoffDeviceKeyInvalid => ("handoff_device_key_invalid", Some(400), false),
    HandoffSignatureMalformed => ("handoff_signature_malformed", Some(400), false),
    HandoffTimestampSkewed => ("handoff_timestamp_skewed", Some(400), false),
    HandoffJwtMissing => ("handoff_jwt_missing", Some(401), false),
    HandoffOwnerMismatch => ("handoff_owner_mismatch", Some(403), false),
    DeviceCapReached => ("device_cap_reached", Some(409), false),
    PushEndpointInvalid => ("push_endpoint_invalid", Some(400), false),
    PushRelayDisallowed => ("push_relay_disallowed", Some(409), false),
    PushDisabled => ("push_disabled", Some(409), false),
    LastAdmin => ("last_admin", Some(409), false),
    RelayAppUnknown => ("relay_app_unknown", Some(400), false),
    RelayVapidInvalid => ("relay_vapid_invalid", Some(401), false),
    RelayVapidMismatch => ("relay_vapid_mismatch", Some(403), false),
    RelayEndpointInvalid => ("relay_endpoint_invalid", Some(404), false),
    RelayUpstreamFailed => ("relay_upstream_failed", Some(502), false),
    PushEndpointGone => ("push_endpoint_gone", Some(410), false),
}

/// The status-class fallback for an unknown code: 429 and 5xx retry, nothing else does.
pub fn retryable_status(status: u16) -> bool {
    status == 429 || status >= 500
}

impl Serialize for ErrorCode {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ErrorCode {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(ErrorCode::parse(&String::deserialize(d)?))
    }
}

/// The `error` member of the envelope. `code` stays a string so a newer server's code
/// survives a round trip; [`ErrorBody::code`] interprets it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Map<String, serde_json::Value>>,
}

impl ErrorBody {
    pub fn code(&self) -> ErrorCode {
        ErrorCode::parse(&self.code)
    }
}

/// Every non-2xx JSON response of the Worker, the relay and `/__yaran/handoff`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub error: ErrorBody,
    pub request_id: String,
}

impl Validate for ErrorEnvelope {
    fn validate(&self) -> Checked {
        check(rules::is_error_code(&self.error.code), "error.code")?;
        check(
            rules::chars_between(&self.error.message, 1, 1024),
            "error.message",
        )?;
        check(rules::is_request_id(&self.request_id), "request_id")
    }
}

impl ErrorEnvelope {
    /// Whether the caller may retry: the registry's answer for a known code, else the
    /// status class.
    pub fn is_retryable(&self, status: u16) -> bool {
        match self.error.code() {
            ErrorCode::Unknown => retryable_status(status),
            known => known.is_retryable(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::{assert_api_type, load};

    #[test]
    fn the_error_envelope_matches_the_schema_fixtures() {
        assert_api_type::<ErrorEnvelope>("ErrorEnvelope");
    }

    #[test]
    fn error_code_equals_the_registry_minus_local_codes() {
        let registry = load("registry/errors.json");
        let entries: Vec<_> = registry["codes"]
            .as_array()
            .expect("codes")
            .iter()
            .filter(|c| c["local"].as_bool() != Some(true))
            .collect();
        assert_eq!(entries.len(), ErrorCode::ALL.len(), "variant count");
        for (entry, code) in entries.iter().zip(ErrorCode::ALL) {
            assert_eq!(entry["code"].as_str(), Some(code.as_str()));
            assert_eq!(
                entry["status"].as_u64().map(|s| s as u16),
                code.status(),
                "{}",
                code.as_str()
            );
            assert_eq!(
                entry["retryable"].as_bool(),
                Some(code.is_retryable()),
                "{}",
                code.as_str()
            );
            assert_eq!(ErrorCode::parse(code.as_str()), *code);
        }
    }

    #[test]
    fn an_unknown_code_falls_back_to_the_status_class() {
        let raw =
            r#"{"error":{"code":"brand_new","message":"m","retryable":true},"request_id":"r"}"#;
        let env: ErrorEnvelope = serde_json::from_str(raw).expect("parses");
        assert_eq!(env.error.code(), ErrorCode::Unknown);
        assert!(env.is_retryable(503));
        assert!(!env.is_retryable(404));
        assert_eq!(
            serde_json::to_value(&env).expect("ser")["error"]["code"],
            "brand_new"
        );
    }
}
