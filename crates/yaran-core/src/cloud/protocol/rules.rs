//! Cloud protocol value rules: the Rust twin of `cloud/protocol/schemas/common.schema.json`.
//!
//! JSON Schema is the source of truth; Rust types are hand-written serde, so every
//! constraint a schema states is re-checked here and wired into each type's
//! `Validate::validate`. The shared fixtures under `cloud/protocol/fixtures/api/` tie the
//! two together: a schema-valid value must pass, a schema-invalid one must fail.
//!
//! - Pure functions; the only side effect is drawing a throwaway ECDH key to let ring
//!   validate a P-256 point (ring has no public on-curve check of its own).
//! - Lengths count characters (code points), as JSON Schema does, never bytes.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/rules.rs
//! └── cloud::protocol::test_fixtures
//! External: base64, chrono, regex, ring, serde, serde_json, std
//!
//! Used by:
//! cloud/protocol/rules.rs
//! ├── cloud::access_jwks
//! ├── cloud::access_jwks::tests
//! ├── cloud::access_jwt
//! ├── cloud::config
//! ├── cloud::credentials
//! ├── cloud::identity
//! ├── cloud::login
//! ├── cloud::loopback
//! ├── cloud::machine_api
//! ├── cloud::org_url
//! ├── cloud::pkce
//! ├── cloud::protocol
//! ├── cloud::protocol::errors
//! ├── cloud::protocol::handoff
//! ├── cloud::protocol::handoff::tests
//! ├── cloud::protocol::handoff_consent
//! ├── cloud::protocol::machine
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::pairing
//! ├── cloud::protocol::signing
//! ├── cloud::protocol::test_fixtures
//! ├── cloud::protocol::uri
//! ├── cloud::test_support
//! ├── yaran-core[test cloud_login]
//! ├── yaran-web::cloud_handoff
//! ├── yaran-web::cloud_handoff_request
//! ├── yaran-web::cloud_handoff_tests
//! ├── yaran-web::cloud_ingress
//! ├── yaran-web::cloud_test_support
//! ├── yaran-web::handoff_consent_page
//! └── yaran-web::handoff_csrf
//! └── yaran-core[test cloud_push_emitter]::mock_worker
//! <module-headers:end>

use std::fmt;
use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use regex::Regex;
use ring::agreement;
use ring::rand::SystemRandom;
use serde::{Deserialize, Deserializer};

/// The field (or rule) a value failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

impl fmt::Display for Invalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the cloud protocol field `{}` is invalid", self.0)
    }
}

impl std::error::Error for Invalid {}

pub type Checked = Result<(), Invalid>;

/// Schema constraints serde cannot express (patterns, bounds, cross-field rules).
pub trait Validate {
    fn validate(&self) -> Checked;
}

/// `Ok` when `ok`, else the named field.
pub fn check(ok: bool, field: &'static str) -> Checked {
    if ok { Ok(()) } else { Err(Invalid(field)) }
}

/// Validates an optional value when present.
pub fn check_opt<T>(value: &Option<T>, ok: impl Fn(&T) -> bool, field: &'static str) -> Checked {
    check(value.as_ref().is_none_or(ok), field)
}

/// A required-but-nullable field: present as `null` or a value, never absent.
pub fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

macro_rules! pattern {
    ($name:ident, $re:expr) => {
        static $name: LazyLock<Regex> =
            LazyLock::new(|| Regex::new($re).expect("cloud protocol pattern compiles"));
    };
}

pattern!(
    UUID,
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
);
pattern!(YARAN_ID, r"^[\x21-\x7e]{1,128}$");
pattern!(
    TIMESTAMP,
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
);
pattern!(DATE, r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$");
pattern!(B64URL, r"^[A-Za-z0-9_-]*$");
pattern!(P256_POINT, r"^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$");
pattern!(ED25519_KEY, r"^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$");
pattern!(ECDSA_SIG, r"^[A-Za-z0-9_-]{85}[AQgw]$");
pattern!(
    ORG_URL,
    r"^https://(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"
);
pattern!(
    HOSTNAME,
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"
);
pattern!(MACHINE_NAME, r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$");
pattern!(USER_SLUG, r"^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$");
pattern!(
    SEMVER,
    r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.-]{1,32})?$"
);
pattern!(REQUEST_ID, r"^[A-Za-z0-9-]{1,64}$");
pattern!(STATE, r"^[A-Za-z0-9_-]{22,128}$");
pattern!(B64URL_43, r"^[A-Za-z0-9_-]{43}$");
pattern!(UNIX_SECONDS, r"^(?:0|[1-9][0-9]{0,11})$");
pattern!(ERROR_CODE, r"^[a-z][a-z0-9_]{0,63}$");
pattern!(FINGERPRINT, r"^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}$");

pub fn is_uuid(s: &str) -> bool {
    UUID.is_match(s)
}
pub fn is_yaran_id(s: &str) -> bool {
    YARAN_ID.is_match(s)
}
/// RFC 3339 UTC with seconds precision and `Z`, and a real calendar instant.
pub fn is_timestamp(s: &str) -> bool {
    TIMESTAMP.is_match(s) && chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%SZ").is_ok()
}
/// JSON Schema `format: date`.
pub fn is_date(s: &str) -> bool {
    DATE.is_match(s) && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}
pub fn is_b64url(s: &str) -> bool {
    B64URL.is_match(s)
}
/// shortcut: one '@', non-empty parts, a dot in the domain, no whitespace; the TS side uses
/// a full RFC 5321 check, upgrade if a fixture ever separates the two.
pub fn is_email(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    s.chars().count() <= 254
        && !local.is_empty()
        && domain.contains('.')
        && !domain.contains('@')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !s.chars().any(char::is_whitespace)
}
pub fn is_org_url(s: &str) -> bool {
    ORG_URL.is_match(s)
}
pub fn is_hostname(s: &str) -> bool {
    s.len() <= 253 && HOSTNAME.is_match(s)
}
pub fn is_machine_name(s: &str) -> bool {
    MACHINE_NAME.is_match(s)
}
pub fn is_user_slug(s: &str) -> bool {
    USER_SLUG.is_match(s)
}
pub fn is_semver(s: &str) -> bool {
    SEMVER.is_match(s)
}
pub fn is_origin_port(p: i64) -> bool {
    (1..=65535).contains(&p)
}
pub fn is_request_id(s: &str) -> bool {
    REQUEST_ID.is_match(s)
}
/// The 22–128 character state/csrf token shape.
pub fn is_state(s: &str) -> bool {
    STATE.is_match(s)
}
/// A 43-character base64url value (32 bytes: pair codes, PKCE challenges).
pub fn is_b64url_43(s: &str) -> bool {
    B64URL_43.is_match(s)
}
/// Decimal Unix seconds, no sign or leading zeros.
pub fn is_unix_seconds(s: &str) -> bool {
    UNIX_SECONDS.is_match(s)
}
pub fn is_error_code(s: &str) -> bool {
    ERROR_CODE.is_match(s)
}
pub fn is_ed25519_public_key(s: &str) -> bool {
    ED25519_KEY.is_match(s)
}
pub fn is_ecdsa_sig(s: &str) -> bool {
    ECDSA_SIG.is_match(s)
}
pub fn is_fingerprint(s: &str) -> bool {
    FINGERPRINT.is_match(s)
}
/// A `P256Point` string that decodes to an on-curve uncompressed point.
pub fn is_p256_point(s: &str) -> bool {
    decode_p256_point(s).is_some()
}

/// Character count within `min..=max`.
pub fn chars_between(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.chars().count())
}

/// Strict base64url (no padding, canonical trailing bits).
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes a `P256Point`: strict base64url, 65 bytes, 0x04 prefix, on the curve.
pub fn decode_p256_point(s: &str) -> Option<[u8; 65]> {
    if !P256_POINT.is_match(s) {
        return None;
    }
    let raw: [u8; 65] = b64url_decode(s)?.try_into().ok()?;
    is_on_p256(&raw).then_some(raw)
}

/// True when `raw` is an uncompressed point ring accepts as an ECDH peer (on the curve,
/// coordinates in range, not the point at infinity).
pub fn is_on_p256(raw: &[u8]) -> bool {
    if raw.len() != 65 || raw[0] != 0x04 {
        return false;
    }
    let Ok(key) =
        agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &SystemRandom::new())
    else {
        return false;
    };
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, raw);
    agreement::agree_ephemeral(key, &peer, |_| ()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::api_cases;

    fn agrees(type_name: &str, rule: impl Fn(&serde_json::Value) -> bool) {
        let (valid, invalid) = api_cases(type_name);
        for (name, value) in valid {
            assert!(rule(&value), "{type_name} `{name}` should be valid");
        }
        for (name, value) in invalid {
            assert!(!rule(&value), "{type_name} `{name}` should be invalid");
        }
    }

    fn str_rule(f: fn(&str) -> bool) -> impl Fn(&serde_json::Value) -> bool {
        move |v| v.as_str().is_some_and(f)
    }

    #[test]
    fn the_common_rules_agree_with_the_schema_fixtures() {
        agrees("Uuid", str_rule(is_uuid));
        agrees("InstallId", str_rule(is_uuid));
        agrees("YaranId", str_rule(is_yaran_id));
        agrees("Timestamp", str_rule(is_timestamp));
        agrees("B64url", str_rule(is_b64url));
        agrees("P256Point", str_rule(is_p256_point));
        agrees("Ed25519PublicKey", str_rule(is_ed25519_public_key));
        agrees("Email", str_rule(is_email));
        agrees("OrgUrl", str_rule(is_org_url));
        agrees("Hostname", str_rule(is_hostname));
        agrees("MachineName", str_rule(is_machine_name));
        agrees("UserSlug", str_rule(is_user_slug));
        agrees("SemVer", str_rule(is_semver));
        agrees("MachineKeyFingerprint", str_rule(is_fingerprint));
        agrees("DeviceKeyFingerprint", str_rule(is_fingerprint));
        agrees("EcdsaP256Sig", str_rule(is_ecdsa_sig));
        agrees("RequestId", str_rule(is_request_id));
        agrees("OriginPort", |v| {
            v.as_i64().is_some_and(is_origin_port) && v.is_i64()
        });
    }

    #[test]
    fn an_off_curve_point_is_refused_even_with_a_well_formed_encoding() {
        let mut raw = [0u8; 65];
        raw[0] = 4;
        raw[64] = 1;
        assert!(!is_on_p256(&raw));
        assert!(decode_p256_point(&b64url_encode(&raw)).is_none());
    }
}
