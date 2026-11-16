//! Cloudflare Access signing keys: the team domain they come from, the JWKS they are
//! published as, and the one blocking fetch that downloads them (Phase 11 §4).
//!
//! `TeamDomain` is the only thing that decides where the fetch goes, and it accepts
//! nothing but `<label>.cloudflareaccess.com` or `<label>.fed.cloudflareaccess.com`
//! (cloudflared's own rule), so a bad credentials file cannot point it anywhere else.
//! `Jwks` keeps only RSA signing keys of at least 2048 bits, matched on `kid`; the
//! `public_cert` member is never read (Cloudflare's validating-JSON guidance).
//!
//! - Trust boundary: the JWKS body and the `Cache-Control` header are network input.
//! - `fetch_jwks` BLOCKS: callers run it on a blocking task, never a reactor thread.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/access_jwks.rs
//! ├── cloud::access_jwks::tests
//! ├── cloud::protocol::rules
//! └── sanitize
//! External: serde_json, std, tracing, ureq
//!
//! Used by:
//! cloud/access_jwks.rs
//! ├── cloud
//! ├── cloud::access_jwks::tests
//! ├── cloud::access_jwt
//! ├── cloud::access_jwt::tests
//! ├── yaran-web::cloud_ingress
//! ├── yaran-web::cloud_jwks_cache
//! └── yaran-web::cloud_test_support
//! <module-headers:end>

use std::time::Duration;

use serde_json::Value;

use super::protocol::rules::b64url_decode;

/// The upper bound on a JWKS body; Cloudflare's is a few KiB.
const MAX_JWKS_BYTES: u64 = 256 * 1024;
const MIN_MODULUS_BITS: usize = 2048;

/// A validated Access team domain (lowercase host, no scheme, no path, no port).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamDomain(String);

impl TeamDomain {
    /// Accepts `<label>.cloudflareaccess.com` or `<label>.fed.cloudflareaccess.com`,
    /// bare (as the credentials store it) or prefixed with `https://`.
    pub fn parse(raw: &str) -> Option<Self> {
        let host = raw.strip_prefix("https://").unwrap_or(raw);
        let label = host
            .strip_suffix(".fed.cloudflareaccess.com")
            .or_else(|| host.strip_suffix(".cloudflareaccess.com"))?;
        let ok = !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        ok.then(|| Self(host.to_string()))
    }

    pub fn host(&self) -> &str {
        &self.0
    }

    /// The exact `iss` an Access token for this team carries (no trailing slash).
    pub fn issuer(&self) -> String {
        format!("https://{}", self.0)
    }

    pub fn certs_url(&self) -> String {
        format!("https://{}/cdn-cgi/access/certs", self.0)
    }
}

/// One RSA verification key; `n` and `e` are big-endian with no leading zeros.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RsaKey {
    pub kid: String,
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

/// The usable keys of one JWKS document.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Jwks {
    keys: Vec<RsaKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JwksError {
    /// Not JSON, or no `keys` array.
    Malformed,
    /// Parsed, but no key survived the filters.
    NoUsableKeys,
}

impl std::fmt::Display for JwksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed => write!(f, "the Access JWKS is not a JSON key set"),
            Self::NoUsableKeys => write!(
                f,
                "the Access JWKS holds no RS256 signing key of at least 2048 bits"
            ),
        }
    }
}

fn strip_zeros(mut bytes: Vec<u8>) -> Vec<u8> {
    let lead = bytes.iter().take_while(|b| **b == 0).count();
    bytes.drain(..lead);
    bytes
}

fn parse_key(k: &Value) -> Option<RsaKey> {
    let s = |name: &str| k.get(name).and_then(Value::as_str);
    let optional_is = |name: &str, want: &str| k.get(name).is_none() || s(name) == Some(want);
    if s("kty") != Some("RSA") || !optional_is("alg", "RS256") || !optional_is("use", "sig") {
        return None;
    }
    let kid = s("kid").filter(|kid| !kid.is_empty())?.to_string();
    let n = strip_zeros(b64url_decode(s("n")?)?);
    let e = strip_zeros(b64url_decode(s("e")?)?);
    (n.len() * 8 >= MIN_MODULUS_BITS && !e.is_empty()).then_some(RsaKey { kid, n, e })
}

impl Jwks {
    /// Keeps RSA keys whose `alg` is absent or RS256 and whose `use` is absent or sig,
    /// with a modulus of at least 2048 bits; anything else is skipped.
    pub fn parse(body: &str) -> Result<Self, JwksError> {
        let doc: Value = serde_json::from_str(body).map_err(|_| JwksError::Malformed)?;
        let entries = doc
            .get("keys")
            .and_then(Value::as_array)
            .ok_or(JwksError::Malformed)?;
        let mut keys = Vec::new();
        for entry in entries {
            let Some(key) = parse_key(entry) else {
                let kid = entry.get("kid").and_then(|k| k.as_str()).unwrap_or("");
                tracing::debug!(
                    target: "yaran::cloud::jwks",
                    kid = %crate::sanitize::for_terminal(kid),
                    "skipped an Access JWKS entry that is not an RS256 signing key of 2048+ bits"
                );
                continue;
            };
            keys.push(key);
        }
        if keys.is_empty() {
            return Err(JwksError::NoUsableKeys);
        }
        Ok(Self { keys })
    }

    pub fn get(&self, kid: &str) -> Option<&RsaKey> {
        self.keys.iter().find(|k| k.kid == kid)
    }

    pub fn kids(&self) -> impl Iterator<Item = &str> {
        self.keys.iter().map(|k| k.kid.as_str())
    }
}

/// `max-age` from a `Cache-Control` value, when present and numeric.
pub fn parse_max_age(cache_control: &str) -> Option<Duration> {
    cache_control.split(',').find_map(|directive| {
        let (name, value) = directive.trim().split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("max-age")
            .then(|| value.trim().trim_matches('"').parse().ok())?
            .map(Duration::from_secs)
    })
}

/// Downloads the team's JWKS. BLOCKING. Returns the keys and the response's `max-age`.
pub fn fetch_jwks(
    team: &TeamDomain,
    timeout: Duration,
) -> Result<(Jwks, Option<Duration>), String> {
    fetch_jwks_from(&team.certs_url(), timeout)
}

/// The fetch behind [`fetch_jwks`], with the URL open so tests can aim it at a fake.
/// Every error string is sanitized, so a hostile body cannot reach a log raw.
pub fn fetch_jwks_from(url: &str, timeout: Duration) -> Result<(Jwks, Option<Duration>), String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .build()
        .into();
    let fail = |what: String| crate::sanitize::for_terminal(&what);
    let mut response = agent
        .get(url)
        .header("Accept", "application/json")
        .call()
        .map_err(|e| fail(format!("could not reach {url}: {e}")))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(fail(format!("{url} answered HTTP {status}")));
    }
    let max_age = response
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_max_age);
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_JWKS_BYTES)
        .read_to_string()
        .map_err(|e| fail(format!("could not read the JWKS from {url}: {e}")))?;
    let jwks = Jwks::parse(&body).map_err(|e| fail(format!("{url}: {e}")))?;
    Ok((jwks, max_age))
}

#[cfg(test)]
#[path = "access_jwks_tests.rs"]
mod tests;
