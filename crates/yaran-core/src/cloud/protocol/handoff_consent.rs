//! Remembered handoff consent (Design §8.1, D24): the device signature the phone's
//! hardware-held key makes over each handoff request, and the MACed consent cookie that
//! lets a renewal from the same device skip the consent page on `/__yaran/handoff`.
//!
//! The page is skipped only when the cookie verifies under the current key version, its
//! fingerprint equals the request's device key, the device signature verified and `dts`
//! is fresh. A well-formed signature that does not verify is not an error (it yields the
//! consent page); only malformed fields map to the three §8.1 registry codes. A failing
//! cookie is ignored, never raised and never cleared.
//!
//! - Trust boundary: `dk`, `dts`, `dsig`, `pk`, `state` and the cookie are attacker
//!   input; `host` must be the server's own bound hostname, never a query value.
//! - MACs are compared in constant time (`ring::hmac::verify`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/handoff_consent.rs
//! ├── cloud::protocol::errors
//! ├── cloud::protocol::fingerprint
//! ├── cloud::protocol::handoff
//! └── cloud::protocol::rules
//! External: ring
//!
//! Used by:
//! cloud/protocol/handoff_consent.rs
//! └── cloud::protocol
//! <module-headers:end>

use ring::{hkdf, hmac, signature};

use super::errors::ErrorCode;
use super::fingerprint::{display_fingerprint, fingerprint24};
use super::handoff::HandoffDecision;
use super::rules::{self, b64url_decode, b64url_encode};

pub const HANDOFF_DEVICE_TAG: &str = "yaran-handoff-device-v1";
pub const DEVICE_KEY_TAG: &str = "yaran-device-key-v1\n";
pub const HANDOFF_DTS_SKEW_S: i64 = 300;
pub const CONSENT_COOKIE_NAME: &str = "__Secure-yaran-handoff-consent";
/// 400 days, the browser cap.
pub const CONSENT_MAX_AGE_S: i64 = 34_560_000;
pub const CONSENT_IAT_FUTURE_S: i64 = 300;
pub const CONSENT_MAC_TAG: &str = "yaran-handoff-consent-v1";
/// The cookie path on the machine hostname (the Worker's is `/v1/handoff`).
pub const MACHINE_HANDOFF_PATH: &str = "/__yaran/handoff";

/// P-256 group order n, big-endian.
const P256_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0xbc, 0xe6, 0xfa, 0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

/// The five LF-terminated lines the device key signs.
pub fn handoff_device_canonical(host: &str, pk: &str, state: &str, dts: &str) -> String {
    format!("{HANDOFF_DEVICE_TAG}\n{host}\n{pk}\n{state}\n{dts}\n")
}

/// A malformed device field (§8.1); each maps to one registry code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceFieldError {
    DeviceKeyInvalid,
    SignatureMalformed,
    /// `dts` outside ±300 s; the redirect adds `&server_time=<unix s>`.
    TimestampSkewed {
        server_time: i64,
    },
}

impl DeviceFieldError {
    pub fn code(self) -> ErrorCode {
        match self {
            Self::DeviceKeyInvalid => ErrorCode::HandoffDeviceKeyInvalid,
            Self::SignatureMalformed => ErrorCode::HandoffSignatureMalformed,
            Self::TimestampSkewed { .. } => ErrorCode::HandoffTimestampSkewed,
        }
    }
}

/// The raw r ‖ s of `dsig` when it is 86 base64url chars with 0 < r, s < n.
pub fn parse_raw_signature(dsig: &str) -> Option<[u8; 64]> {
    if dsig.len() != 86 {
        return None;
    }
    let raw: [u8; 64] = b64url_decode(dsig)?.try_into().ok()?;
    let in_range = |x: &[u8]| x.iter().any(|b| *b != 0) && x < &P256_N[..];
    (in_range(&raw[..32]) && in_range(&raw[32..])).then_some(raw)
}

/// Form and freshness checks in §8.1 order (missing fields fail as malformed ones).
pub fn check_device_fields(
    dk: Option<&str>,
    dts: Option<&str>,
    dsig: Option<&str>,
    now: i64,
) -> Result<(), DeviceFieldError> {
    if dk.and_then(rules::decode_p256_point).is_none() {
        return Err(DeviceFieldError::DeviceKeyInvalid);
    }
    let dts = dts
        .filter(|d| rules::is_unix_seconds(d))
        .and_then(|d| d.parse::<i64>().ok());
    let (Some(dts), Some(_)) = (dts, dsig.and_then(parse_raw_signature)) else {
        return Err(DeviceFieldError::SignatureMalformed);
    };
    if (now - dts).abs() > HANDOFF_DTS_SKEW_S {
        return Err(DeviceFieldError::TimestampSkewed { server_time: now });
    }
    Ok(())
}

/// Verifies `dsig` (ES256, raw r ‖ s) over the canonical string with `dk`. Call after
/// `check_device_fields` passes; anything unparseable is simply `false`.
pub fn verify_device_signature(
    host: &str,
    pk: &str,
    state: &str,
    dts: &str,
    dk: &str,
    dsig: &str,
) -> bool {
    let (Some(point), Some(sig)) = (rules::decode_p256_point(dk), parse_raw_signature(dsig)) else {
        return false;
    };
    signature::UnparsedPublicKey::new(&signature::ECDSA_P256_SHA256_FIXED, point)
        .verify(
            handoff_device_canonical(host, pk, state, dts).as_bytes(),
            &sig,
        )
        .is_ok()
}

/// The 24-character device fingerprint (the cookie's `fp24`).
pub fn device_key_fp24(dk: &[u8; 65]) -> String {
    fingerprint24(DEVICE_KEY_TAG, dk)
}

/// `DeviceKeyFingerprint`, the 29-character display form.
pub fn device_key_fingerprint(dk: &[u8; 65]) -> String {
    display_fingerprint(&device_key_fp24(dk))
}

/// The ASCII bytes the cookie MAC covers; `host` is bound here, not carried in the value.
pub fn consent_mac_input(host: &str, fp24: &str, iat: i64, kv: u32) -> String {
    format!("{CONSENT_MAC_TAG}\n{host}\n{fp24}\n{iat}\n{kv}\n")
}

/// base64url(HMAC-SHA256(key, mac_in)), 43 characters.
pub fn consent_mac(key: &[u8], host: &str, fp24: &str, iat: i64, kv: u32) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA256, key);
    b64url_encode(hmac::sign(&key, consent_mac_input(host, fp24, iat, kv).as_bytes()).as_ref())
}

/// The cookie value `v1.<kv>.<fp24>.<iat>.<mac>`.
pub fn build_consent_cookie(key: &[u8], kv: u32, host: &str, fp24: &str, iat: i64) -> String {
    format!(
        "v1.{kv}.{fp24}.{iat}.{}",
        consent_mac(key, host, fp24, iat, kv)
    )
}

/// The `Set-Cookie` header value for the handoff path.
pub fn consent_set_cookie(value: &str, path: &str) -> String {
    format!(
        "{CONSENT_COOKIE_NAME}={value}; Path={path}; Max-Age={CONSENT_MAX_AGE_S}; Secure; HttpOnly; SameSite=Lax"
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConsentCookie {
    pub kv: u32,
    pub fp24: String,
    pub iat: i64,
    pub mac: String,
}

fn is_decimal(s: &str, max_len: usize, allow_zero: bool) -> bool {
    !s.is_empty()
        && s.len() <= max_len
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s == "0" && allow_zero || !s.starts_with('0'))
}

/// Parses the five parts; `None` for anything malformed.
pub fn parse_consent_cookie(value: &str) -> Option<ConsentCookie> {
    let parts: Vec<&str> = value.split('.').collect();
    let [v, kv, fp24, iat, mac] = parts.as_slice() else {
        return None;
    };
    let fp_ok = fp24.len() == 24
        && fp24
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b));
    let mac_ok = mac.len() == 43 && b64url_decode(mac).is_some();
    if *v != "v1" || !is_decimal(kv, 9, false) || !fp_ok || !is_decimal(iat, 12, true) || !mac_ok {
        return None;
    }
    Some(ConsentCookie {
        kv: kv.parse().ok()?,
        fp24: fp24.to_string(),
        iat: iat.parse().ok()?,
        mac: mac.to_string(),
    })
}

/// Why a cookie did not verify (never surfaced to the user; the page is simply shown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CookieRejection {
    Malformed,
    StaleKv,
    BadMac,
    IatFuture,
    IatExpired,
}

impl CookieRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::StaleKv => "stale_kv",
            Self::BadMac => "bad_mac",
            Self::IatFuture => "iat_future",
            Self::IatExpired => "iat_expired",
        }
    }
}

/// Checks a cookie against the current key; only that version verifies. Returns fp24.
pub fn verify_consent_cookie(
    value: &str,
    host: &str,
    key: &[u8],
    current_kv: u32,
    now: i64,
) -> Result<String, CookieRejection> {
    let c = parse_consent_cookie(value).ok_or(CookieRejection::Malformed)?;
    if c.kv != current_kv {
        return Err(CookieRejection::StaleKv);
    }
    let tag = b64url_decode(&c.mac).ok_or(CookieRejection::Malformed)?;
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, key),
        consent_mac_input(host, &c.fp24, c.iat, c.kv).as_bytes(),
        &tag,
    )
    .map_err(|_| CookieRejection::BadMac)?;
    if c.iat > now + CONSENT_IAT_FUTURE_S {
        return Err(CookieRejection::IatFuture);
    }
    if c.iat < now - CONSENT_MAX_AGE_S {
        return Err(CookieRejection::IatExpired);
    }
    Ok(c.fp24)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentSide {
    Worker,
    Yaran,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsentDecision {
    Skip,
    ConsentPage,
}

/// The skip rule's inputs, gathered after every §8 and Access check has passed.
#[derive(Debug, Clone, Copy)]
pub struct RememberedInput<'a> {
    pub side: ConsentSide,
    pub cookie: Option<&'a str>,
    pub host: &'a str,
    /// fp24 of the request's `dk`.
    pub dk_fp24: &'a str,
    pub verified: bool,
    pub dts_fresh: bool,
    /// Worker only (rule 5); yaran never learns of a Worker revocation.
    pub device_revoked: bool,
    pub key: &'a [u8],
    pub current_kv: u32,
    pub now: i64,
}

/// The §8.1 skip rule: every rule must hold, anything else shows the consent page.
pub fn decide_remembered(i: &RememberedInput<'_>) -> ConsentDecision {
    let revoked = match i.side {
        ConsentSide::Worker => i.device_revoked,
        ConsentSide::Yaran => false,
    };
    let skip = i.verified
        && i.dts_fresh
        && !revoked
        && i.cookie
            .and_then(|c| verify_consent_cookie(c, i.host, i.key, i.current_kv, i.now).ok())
            .is_some_and(|fp| fp == i.dk_fp24);
    if skip {
        ConsentDecision::Skip
    } else {
        ConsentDecision::ConsentPage
    }
}

/// Whether the consent POST's 303 carries `Set-Cookie`.
pub fn consent_sets_cookie(decision: HandoffDecision, verified: bool) -> bool {
    match decision {
        HandoffDecision::Continue => verified,
        HandoffDecision::Cancel => false,
    }
}

/// The Worker's consent MAC key: HKDF-SHA256(DATA_KEY, "yaran-cloud", "v1/handoff_consent").
/// yaran keeps its own random key (Phase 09); this exists to pin the shared fixture.
pub fn worker_consent_key(data_key: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    hkdf::Salt::new(hkdf::HKDF_SHA256, b"yaran-cloud")
        .extract(data_key)
        .expand(&[b"v1/handoff_consent"], hkdf::HKDF_SHA256)
        .and_then(|okm| okm.fill(&mut out))
        .expect("a 32-byte HKDF-SHA256 output is always valid");
    out
}

#[cfg(test)]
#[path = "handoff_consent_tests.rs"]
mod tests;
