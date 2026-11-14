//! What a control-plane call can fail with, and the one mapping from an HTTP answer to it.
//!
//! The mapping is keyed on 02's error envelope `code`: `machine_revoked` is `Revoked`,
//! `protocol_unsupported` carries `details {min, max}`, `signature_expired` is
//! `ClockSkew` (from `details.server_time`, else the `Date` header), any other
//! registered code is `Refused`, and an unknown code or a body that is not an envelope
//! falls back to its HTTP status class (02 §4). `Retry-After` is kept on retryable ones.
//!
//! - Trust boundary: every server-supplied string is sanitized and cut to 200
//!   characters here, before anything logs or shows it (T53).
//!
//! <module-headers:begin>
//! <module-headers:end>

use std::fmt;

use crate::cloud::credentials::CredentialsError;
use crate::cloud::protocol::errors::{ErrorCode, ErrorEnvelope, retryable_status};

/// The longest server string yaran logs or shows.
pub const SERVER_TEXT_MAX: usize = 200;

/// Sanitize and truncate text that came from the control plane.
pub fn server_text(s: &str) -> String {
    crate::sanitize::truncate(s, SERVER_TEXT_MAX)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MachineApiError {
    /// `410 machine_revoked`.
    Revoked,
    /// No protocol both sides speak.
    ProtocolUnsupported { min: i64, max: i64, ours: i64 },
    /// `signature_expired`: this machine's clock is off. RFC 3339 server time if known.
    ClockSkew { server_time: Option<String> },
    /// A registered refusal (or an unknown 4xx code), sanitized.
    Refused {
        code: String,
        message: String,
        retry_after: Option<u64>,
    },
    /// A 5xx or 429 without a code this build maps more precisely.
    Server {
        status: u16,
        retry_after: Option<u64>,
    },
    /// The request never got an HTTP answer.
    Network(String),
    /// The answer was not what the contract promises.
    Malformed(String),
    /// A signed call needs credentials and there are none.
    NotPaired,
    /// The credentials exist but could not be used.
    Credentials(CredentialsError),
}

impl fmt::Display for MachineApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Revoked => write!(f, "the control plane says this machine was revoked"),
            Self::ProtocolUnsupported { min, max, ours } => write!(
                f,
                "the control plane speaks protocol {min}..={max} and this yaran speaks {ours}"
            ),
            Self::ClockSkew { server_time } => match server_time {
                Some(t) => write!(f, "this machine's clock is off (the server time is {t})"),
                None => write!(f, "this machine's clock is off"),
            },
            Self::Refused { code, message, .. } => write!(f, "{message} ({code})"),
            Self::Server { status, .. } => write!(f, "the control plane answered HTTP {status}"),
            Self::Network(why) => write!(f, "the control plane could not be reached: {why}"),
            Self::Malformed(why) => write!(f, "the control plane's answer was malformed: {why}"),
            Self::NotPaired => write!(f, "this machine is not paired"),
            Self::Credentials(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for MachineApiError {}

impl From<CredentialsError> for MachineApiError {
    fn from(e: CredentialsError) -> Self {
        Self::Credentials(e)
    }
}

/// Seconds from a `Retry-After` header (delta-seconds form only).
fn parse_retry_after(v: Option<&str>) -> Option<u64> {
    v?.trim().parse().ok()
}

/// RFC 3339 from an HTTP `Date` header.
fn date_to_rfc3339(v: Option<&str>) -> Option<String> {
    chrono::DateTime::parse_from_rfc2822(v?.trim())
        .ok()
        .map(|d| {
            d.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        })
}

/// Map a non-2xx answer. Returns the error and the request id, if the body named one.
pub fn map_error(
    status: u16,
    body: &str,
    retry_after: Option<&str>,
    date: Option<&str>,
    ours: i64,
) -> (MachineApiError, Option<String>) {
    let retry = parse_retry_after(retry_after);
    let Ok(env) = serde_json::from_str::<ErrorEnvelope>(body) else {
        return (status_class(status, None, retry), None);
    };
    let request_id = Some(server_text(&env.request_id));
    let detail_i64 = |k: &str| {
        env.error
            .details
            .as_ref()
            .and_then(|d| d.get(k))
            .and_then(serde_json::Value::as_i64)
    };
    let retry_kept = if env.is_retryable(status) {
        retry
    } else {
        None
    };
    let err = match env.error.code() {
        ErrorCode::MachineRevoked => MachineApiError::Revoked,
        ErrorCode::ProtocolUnsupported => MachineApiError::ProtocolUnsupported {
            min: detail_i64("min").unwrap_or(0),
            max: detail_i64("max").unwrap_or(0),
            ours,
        },
        ErrorCode::SignatureExpired => MachineApiError::ClockSkew {
            server_time: env
                .error
                .details
                .as_ref()
                .and_then(|d| d.get("server_time"))
                .and_then(serde_json::Value::as_str)
                .map(server_text)
                .or_else(|| date_to_rfc3339(date)),
        },
        ErrorCode::Unknown => status_class(status, Some(&env), retry),
        _ => MachineApiError::Refused {
            code: server_text(&env.error.code),
            message: server_text(&env.error.message),
            retry_after: retry_kept,
        },
    };
    (err, request_id)
}

/// The 02 §4 status-class fallback.
fn status_class(status: u16, env: Option<&ErrorEnvelope>, retry: Option<u64>) -> MachineApiError {
    if retryable_status(status) {
        return MachineApiError::Server {
            status,
            retry_after: retry,
        };
    }
    match env {
        Some(env) => MachineApiError::Refused {
            code: server_text(&env.error.code),
            message: server_text(&env.error.message),
            retry_after: None,
        },
        None => MachineApiError::Server {
            status,
            retry_after: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::api_cases;

    fn envelope(code: &str, details: serde_json::Value) -> String {
        serde_json::json!({
            "error": {"code": code, "message": "m", "retryable": false, "details": details},
            "request_id": "req-1"
        })
        .to_string()
    }

    #[test]
    fn the_shared_error_envelope_fixtures_map_to_clock_skew() {
        for (name, value) in api_cases("ErrorEnvelope").0 {
            let (err, id) = map_error(401, &value.to_string(), None, None, 1);
            assert!(matches!(err, MachineApiError::ClockSkew { .. }), "{name}");
            assert_eq!(id.as_deref(), Some("8d1f2c3b4a5e6f70-LHR"));
        }
    }

    #[test]
    fn every_code_this_client_names_maps_to_its_variant() {
        let refused = [
            ("signature_missing", 401),
            ("signature_invalid", 401),
            ("nonce_replayed", 401),
            ("machine_unknown", 401),
            ("pair_code_invalid", 400),
            ("pkce_mismatch", 400),
            ("machine_name_invalid", 400),
            ("machine_cap_reached", 409),
            ("origin_port_invalid", 400),
        ];
        for (code, status) in refused {
            let (err, _) = map_error(
                status,
                &envelope(code, serde_json::json!({})),
                None,
                None,
                1,
            );
            assert!(
                matches!(&err, MachineApiError::Refused { code: c, .. } if c == code),
                "{code}: {err:?}"
            );
        }
        let (err, _) = map_error(
            409,
            &envelope("machine_not_ready", serde_json::json!({})),
            Some("7"),
            None,
            1,
        );
        assert!(matches!(
            err,
            MachineApiError::Refused {
                retry_after: Some(7),
                ..
            }
        ));
        for code in ["rate_limited", "unavailable"] {
            let (err, _) = map_error(
                429,
                &envelope(code, serde_json::json!({})),
                Some("3"),
                None,
                1,
            );
            assert!(
                matches!(
                    err,
                    MachineApiError::Refused {
                        retry_after: Some(3),
                        ..
                    }
                ),
                "{code}"
            );
        }
        let (err, _) = map_error(
            410,
            &envelope("machine_revoked", serde_json::json!({})),
            None,
            None,
            1,
        );
        assert_eq!(err, MachineApiError::Revoked);
        let (err, _) = map_error(
            400,
            &envelope(
                "protocol_unsupported",
                serde_json::json!({"min": 2, "max": 3}),
            ),
            None,
            None,
            1,
        );
        assert_eq!(
            err,
            MachineApiError::ProtocolUnsupported {
                min: 2,
                max: 3,
                ours: 1
            }
        );
        let (err, _) = map_error(
            401,
            &envelope("signature_expired", serde_json::json!({})),
            None,
            Some("Sat, 14 Nov 2026 12:00:00 GMT"),
            1,
        );
        assert_eq!(
            err,
            MachineApiError::ClockSkew {
                server_time: Some("2026-11-14T12:00:00Z".into())
            }
        );
    }

    #[test]
    fn an_unknown_code_or_no_envelope_falls_back_to_the_status_class() {
        let (err, _) = map_error(
            503,
            &envelope("brand_new", serde_json::json!({})),
            Some("9"),
            None,
            1,
        );
        assert_eq!(
            err,
            MachineApiError::Server {
                status: 503,
                retry_after: Some(9)
            }
        );
        let (err, _) = map_error(
            404,
            &envelope("brand_new", serde_json::json!({})),
            None,
            None,
            1,
        );
        assert!(matches!(err, MachineApiError::Refused { code, .. } if code == "brand_new"));
        let (err, id) = map_error(502, "<html>bad gateway</html>", None, None, 1);
        assert_eq!(
            err,
            MachineApiError::Server {
                status: 502,
                retry_after: None
            }
        );
        assert_eq!(id, None);
    }

    #[test]
    fn hostile_server_text_is_sanitized_and_truncated() {
        let body = serde_json::json!({
            "error": {"code": "pkce_mismatch", "message": format!("\u{1b}]52;c;evil\u{7}{}", "x".repeat(500)), "retryable": false},
            "request_id": "req-1"
        })
        .to_string();
        let (err, _) = map_error(400, &body, None, None, 1);
        let MachineApiError::Refused { message, .. } = err else {
            panic!("refused");
        };
        assert!(!message.contains('\u{1b}') && !message.contains('\u{7}'));
        assert_eq!(message.chars().count(), SERVER_TEXT_MAX);
    }
}
