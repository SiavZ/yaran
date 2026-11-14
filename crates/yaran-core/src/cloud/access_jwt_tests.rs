//! Tests for the Access verifier: every named case of `fixtures/access-jwt/tokens.json`,
//! the skew boundaries, rotation, and the refusal-code mapping against 02's registry.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::access_jwt`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/access_jwt_tests.rs
//! ├── cloud::access_jwks
//! ├── cloud::access_jwt
//! └── cloud::protocol::test_fixtures
//! External: serde_json, std
//!
//! Used by:
//! cloud/access_jwt_tests.rs
//! └── cloud::access_jwt
//! <module-headers:end>

use std::collections::HashSet;

use serde_json::Value;

use super::*;
use crate::cloud::access_jwks::Jwks;
use crate::cloud::protocol::test_fixtures::{fixture, load};

fn tokens() -> Value {
    fixture("access-jwt/tokens.json")
}

fn jwks(name: &str) -> Jwks {
    Jwks::parse(&fixture(&format!("access-jwt/{name}")).to_string()).expect("fixture JWKS")
}

fn expectations(t: &Value) -> Expectations {
    Expectations {
        team: TeamDomain::parse(t["team_domain"].as_str().unwrap()).unwrap(),
        aud: t["aud"].as_str().unwrap().to_string(),
        owner_email: t["owner_email"].as_str().unwrap().to_string(),
        skew: Duration::from_secs(t["skew_seconds"].as_u64().unwrap()),
    }
}

fn at(secs: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(secs as u64)
}

fn token(t: &Value, name: &str) -> String {
    t["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no case {name}"))["token"]
        .as_str()
        .unwrap()
        .to_string()
}

#[test]
fn every_fixture_case_gets_its_expected_outcome() {
    let t = tokens();
    let (keys, expect) = (jwks("jwks.json"), expectations(&t));
    let now = at(t["now"].as_i64().unwrap());
    let cases = t["cases"].as_array().unwrap();
    assert!(cases.len() >= 15);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let got = verify(c["token"].as_str().unwrap(), &keys, &expect, now);
        match c["expect"].as_str().unwrap() {
            "ok" => {
                let v = got.unwrap_or_else(|e| panic!("{name}: {e:?}"));
                assert_eq!(v.jwt, c["token"].as_str().unwrap(), "{name}");
                assert!(v.email.eq_ignore_ascii_case("owner@example.com"), "{name}");
                assert!(!v.sub.is_empty(), "{name}");
            }
            code => assert_eq!(got.map(|_| ()).map_err(|e| e.code()), Err(code), "{name}"),
        }
    }
}

#[test]
fn an_empty_token_is_missing() {
    let t = tokens();
    let got = verify("", &jwks("jwks.json"), &expectations(&t), at(0));
    assert_eq!(got, Err(AccessRejection::Missing));
}

#[test]
fn expiry_and_not_before_hold_to_the_second_of_the_skew() {
    let t = tokens();
    let (keys, expect) = (jwks("jwks.json"), expectations(&t));
    let valid = token(&t, "valid");
    let claims: Value =
        serde_json::from_slice(&b64url_decode(valid.split('.').nth(1).unwrap()).unwrap()).unwrap();
    let skew = t["skew_seconds"].as_i64().unwrap();
    let (exp, nbf) = (
        claims["exp"].as_i64().unwrap(),
        claims["nbf"].as_i64().unwrap(),
    );
    let check = |now: i64| verify(&valid, &keys, &expect, at(now)).map(|_| ());
    assert_eq!(check(exp + skew - 1), Ok(()));
    assert_eq!(check(exp + skew), Err(AccessRejection::Expired));
    assert_eq!(check(nbf - skew), Ok(()));
    assert_eq!(check(nbf - skew - 1), Err(AccessRejection::NotYetValid));
}

#[test]
fn rotation_keeps_the_current_key_and_drops_the_retired_one() {
    let t = tokens();
    let (rotated, expect) = (jwks("jwks-rotated.json"), expectations(&t));
    let now = at(t["now"].as_i64().unwrap());
    assert!(verify(&token(&t, "valid"), &rotated, &expect, now).is_ok());
    assert_eq!(
        verify(&token(&t, "previous key"), &rotated, &expect, now).map(|_| ()),
        Err(AccessRejection::UnknownKid)
    );
}

#[test]
fn every_rejection_has_a_unique_registered_code() {
    let codes: HashSet<_> = AccessRejection::ALL.iter().map(|r| r.code()).collect();
    assert_eq!(codes.len(), AccessRejection::ALL.len());
    let registry = load("registry/refusals.json");
    let registered: HashSet<_> = registry["refusals"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["code"].as_str().unwrap())
        .collect();
    for r in AccessRejection::ALL {
        assert!(registered.contains(r.code()), "{}", r.code());
        let want = if *r == AccessRejection::NotOwner {
            403
        } else {
            401
        };
        assert_eq!(r.status(), want, "{}", r.code());
    }
}

#[test]
fn debug_output_never_shows_the_token() {
    let t = tokens();
    let valid = token(&t, "valid");
    let v = verify(
        &valid,
        &jwks("jwks.json"),
        &expectations(&t),
        at(t["now"].as_i64().unwrap()),
    )
    .unwrap();
    assert!(!format!("{v:?}").contains(&valid[..40]));
}
