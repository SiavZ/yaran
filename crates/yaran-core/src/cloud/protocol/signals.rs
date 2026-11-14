//! yaran's machine-side signals to the web UI and machine-view (Design §13): the
//! `Yaran-Refusal` header codes and the WebSocket close code for an expired Access session.
//!
//! A 401/403 on a cloud hostname without `Yaran-Refusal` came from Access, not yaran.
//! Clients act on prefixes: `access-keys-unavailable` is a server problem, any other
//! `access-*` means sign in again, `host-*` means the machine is no longer connected.
//! Tests keep both lists equal to `registry/refusals.json` and `registry/close-codes.json`.
//!
//! - Pure constants; Phase 11's `AccessRejection::code()` returns these.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/signals.rs
//! External: (none)
//!
//! Used by:
//! cloud/protocol/signals.rs
//! └── cloud::protocol
//! <module-headers:end>

/// Sent on PTY and events sockets of a cloud-hostname connection at the Access JWT's
/// `exp + skew` (`[cloud] close_sockets_at_access_expiry`).
pub const SESSION_EXPIRED_CLOSE_CODE: u16 = 4401;
pub const SESSION_EXPIRED_CLOSE_REASON: &str = "access session expired";
pub const REFUSAL_HEADER: &str = "Yaran-Refusal";

/// Every refusal yaran itself makes for a cloud-hostname request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefusalCode {
    AccessMissing,
    AccessMalformed,
    AccessBadAlgorithm,
    AccessUnknownKid,
    AccessBadSignature,
    AccessWrongIssuer,
    AccessWrongAudience,
    AccessExpired,
    AccessNotYetValid,
    AccessNotAppToken,
    AccessServiceToken,
    AccessNotOwner,
    AccessKeysUnavailable,
    HostNotServed,
    HostMissing,
}

impl RefusalCode {
    /// Every code, in registry order.
    pub const ALL: &[RefusalCode] = &[
        Self::AccessMissing,
        Self::AccessMalformed,
        Self::AccessBadAlgorithm,
        Self::AccessUnknownKid,
        Self::AccessBadSignature,
        Self::AccessWrongIssuer,
        Self::AccessWrongAudience,
        Self::AccessExpired,
        Self::AccessNotYetValid,
        Self::AccessNotAppToken,
        Self::AccessServiceToken,
        Self::AccessNotOwner,
        Self::AccessKeysUnavailable,
        Self::HostNotServed,
        Self::HostMissing,
    ];

    /// The header value.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AccessMissing => "access-missing",
            Self::AccessMalformed => "access-malformed",
            Self::AccessBadAlgorithm => "access-bad-algorithm",
            Self::AccessUnknownKid => "access-unknown-kid",
            Self::AccessBadSignature => "access-bad-signature",
            Self::AccessWrongIssuer => "access-wrong-issuer",
            Self::AccessWrongAudience => "access-wrong-audience",
            Self::AccessExpired => "access-expired",
            Self::AccessNotYetValid => "access-not-yet-valid",
            Self::AccessNotAppToken => "access-not-app-token",
            Self::AccessServiceToken => "access-service-token",
            Self::AccessNotOwner => "access-not-owner",
            Self::AccessKeysUnavailable => "access-keys-unavailable",
            Self::HostNotServed => "host-not-served",
            Self::HostMissing => "host-missing",
        }
    }

    /// The HTTP status the refusal is sent with.
    pub fn status(self) -> u16 {
        match self {
            Self::AccessMissing
            | Self::AccessMalformed
            | Self::AccessBadAlgorithm
            | Self::AccessUnknownKid
            | Self::AccessBadSignature
            | Self::AccessWrongIssuer
            | Self::AccessWrongAudience
            | Self::AccessExpired
            | Self::AccessNotYetValid
            | Self::AccessNotAppToken
            | Self::AccessServiceToken => 401,
            Self::AccessNotOwner | Self::HostNotServed | Self::HostMissing => 403,
            Self::AccessKeysUnavailable => 503,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::load;

    #[test]
    fn refusal_codes_equal_the_registry() {
        let registry = load("registry/refusals.json");
        assert_eq!(registry["header"], REFUSAL_HEADER);
        let entries = registry["refusals"].as_array().unwrap();
        assert_eq!(entries.len(), RefusalCode::ALL.len());
        for (entry, code) in entries.iter().zip(RefusalCode::ALL) {
            assert_eq!(entry["code"], code.as_str());
            assert_eq!(
                entry["status"].as_u64(),
                Some(u64::from(code.status())),
                "{}",
                code.as_str()
            );
        }
    }

    #[test]
    fn the_session_expired_close_code_equals_the_registry() {
        let registry = load("registry/close-codes.json");
        let entry = registry["close_codes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["code"] == SESSION_EXPIRED_CLOSE_CODE)
            .expect("4401 is registered");
        assert_eq!(entry["reason"], SESSION_EXPIRED_CLOSE_REASON);
    }
}
