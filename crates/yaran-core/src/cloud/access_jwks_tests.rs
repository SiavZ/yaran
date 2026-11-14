//! Tests for the team-domain rule, JWKS parsing, `max-age` parsing and the fetch, which
//! runs against a one-shot HTTP server on loopback (never Cloudflare).
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::access_jwks`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/access_jwks_tests.rs
//! ├── cloud::access_jwks
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: serde_json, std
//!
//! Used by:
//! cloud/access_jwks_tests.rs
//! └── cloud::access_jwks
//! <module-headers:end>

use std::io::{Read, Write};
use std::net::TcpListener;

use serde_json::json;

use super::*;
use crate::cloud::protocol::rules::b64url_encode;
use crate::cloud::protocol::test_fixtures::fixture;

#[test]
fn team_domains_follow_cloudflareds_rule() {
    for ok in [
        "acme.cloudflareaccess.com",
        "https://acme.cloudflareaccess.com",
        "acme-2.fed.cloudflareaccess.com",
        "https://acme.fed.cloudflareaccess.com",
    ] {
        let team = TeamDomain::parse(ok).unwrap_or_else(|| panic!("{ok} accepted"));
        assert_eq!(team.issuer(), format!("https://{}", team.host()));
        assert!(team.certs_url().ends_with(".com/cdn-cgi/access/certs"));
    }
    for bad in [
        "",
        "cloudflareaccess.com",
        ".cloudflareaccess.com",
        "http://acme.cloudflareaccess.com",
        "https://evil.com/x.cloudflareaccess.com",
        "evil.com/x.cloudflareaccess.com",
        "a.b.cloudflareaccess.com",
        "acme.cloudflareaccess.com/",
        "acme.cloudflareaccess.com:443",
        "ACME.cloudflareaccess.com",
        "-acme.cloudflareaccess.com",
        "acme.cloudflareaccess.com.evil.com",
        "user@acme.cloudflareaccess.com",
    ] {
        assert_eq!(TeamDomain::parse(bad), None, "{bad} refused");
    }
}

fn rsa(kid: &str, n: &[u8]) -> serde_json::Value {
    json!({"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
           "n": b64url_encode(n), "e": "AQAB"})
}

#[test]
fn parsing_keeps_only_rs256_signing_keys_of_2048_bits() {
    let mut padded = vec![0u8, 0u8];
    padded.extend(vec![0xc5; 256]);
    let mut no_alg = rsa("no-alg", &[0xc5; 256]);
    no_alg.as_object_mut().unwrap().remove("alg");
    let doc = json!({"keys": [
        rsa("padded", &padded),
        no_alg,
        rsa("short", &[0xc5; 128]),
        {"kty": "EC", "kid": "ec", "crv": "P-256", "x": "AA", "y": "AA"},
        {"kty": "oct", "kid": "hs", "k": "c2VjcmV0"},
        {"kty": "RSA", "kid": "ps", "alg": "PS256", "n": b64url_encode(&[0xc5; 256]), "e": "AQAB"},
        {"kty": "RSA", "kid": "enc", "use": "enc", "n": b64url_encode(&[0xc5; 256]), "e": "AQAB"},
    ]});
    let jwks = Jwks::parse(&doc.to_string()).unwrap();
    assert_eq!(jwks.kids().collect::<Vec<_>>(), ["padded", "no-alg"]);
    assert_eq!(
        jwks.get("padded").unwrap().n.len(),
        256,
        "leading zeros stripped"
    );
    assert_eq!(jwks.get("padded").unwrap().e, [1, 0, 1]);
    assert!(jwks.get("short").is_none());
}

#[test]
fn an_unusable_document_is_an_error() {
    assert_eq!(Jwks::parse("not json"), Err(JwksError::Malformed));
    assert_eq!(Jwks::parse("{}"), Err(JwksError::Malformed));
    let only_ec = json!({"keys": [{"kty": "EC", "kid": "ec"}]});
    assert_eq!(
        Jwks::parse(&only_ec.to_string()),
        Err(JwksError::NoUsableKeys)
    );
}

#[test]
fn the_fixture_key_sets_parse() {
    for name in ["jwks.json", "jwks-rotated.json"] {
        let doc = fixture(&format!("access-jwt/{name}"));
        assert_eq!(Jwks::parse(&doc.to_string()).unwrap().kids().count(), 2);
    }
}

#[test]
fn max_age_is_read_from_cache_control() {
    let secs = |s: &str| parse_max_age(s).map(|d| d.as_secs());
    assert_eq!(secs("public, max-age=14400"), Some(14400));
    assert_eq!(secs("Max-Age = 60 ,public"), Some(60));
    assert_eq!(secs("s-maxage=10"), None);
    assert_eq!(secs("max-age=soon"), None);
    assert_eq!(secs("no-store"), None);
}

/// Answers one request with `response` and returns the URL to fetch.
fn one_shot(response: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut conn, _) = listener.accept().unwrap();
        let mut buf = [0u8; 4096];
        let _ = conn.read(&mut buf);
        let _ = conn.write_all(response.as_bytes());
    });
    format!("http://{addr}/cdn-cgi/access/certs")
}

fn http(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}",
        body.len()
    )
}

#[test]
fn the_fetch_returns_keys_and_max_age_from_a_fake_endpoint() {
    let body = fixture("access-jwt/jwks.json").to_string();
    let url = one_shot(http(
        "200 OK",
        "cache-control: public, max-age=14400\r\n",
        &body,
    ));
    let (jwks, max_age) = fetch_jwks_from(&url, Duration::from_secs(5)).unwrap();
    assert_eq!(jwks.kids().count(), 2);
    assert_eq!(max_age, Some(Duration::from_secs(14400)));
}

#[test]
fn a_failing_fetch_names_the_failure_without_raw_escapes() {
    let url = one_shot(http("503 Service Unavailable", "", "down"));
    let err = fetch_jwks_from(&url, Duration::from_secs(5)).unwrap_err();
    assert!(err.contains("HTTP 503"), "{err}");
    let url = one_shot(http("200 OK", "", "{\"keys\":[]}\u{1b}[31m"));
    let err = fetch_jwks_from(&url, Duration::from_secs(5)).unwrap_err();
    assert!(!err.contains('\u{1b}'), "{err}");
}
