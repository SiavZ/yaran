//! Tests for remembered consent against the shared D24 fixtures: device fingerprints,
//! the device signature cases, the consent cookie and the skip decision table.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::protocol::handoff_consent`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/handoff_consent_tests.rs
//! ├── cloud::protocol::handoff_consent
//! └── cloud::protocol::test_fixtures
//! External: none
//!
//! Used by:
//! cloud/protocol/handoff_consent_tests.rs
//! └── cloud::protocol::handoff_consent
//! <module-headers:end>

use super::*;
use crate::cloud::protocol::test_fixtures::{fixture, hex, unhex};

#[test]
fn the_device_fingerprint_fixture_passes() {
    let f = fixture("sig/device-fingerprint.json");
    assert_eq!(f["tag"], DEVICE_KEY_TAG);
    for c in f["cases"].as_array().unwrap() {
        let dk = rules::decode_p256_point(c["dk"].as_str().unwrap()).expect("on-curve dk");
        assert_eq!(hex(&dk), c["dk_hex"]);
        assert_eq!(device_key_fp24(&dk), c["fp24"]);
        assert_eq!(device_key_fingerprint(&dk), c["fingerprint"]);
    }
}

#[test]
fn every_device_signature_case_matches() {
    let f = fixture("sig/handoff-device-signature.json");
    assert_eq!(
        handoff_device_canonical(
            f["host"].as_str().unwrap(),
            f["pk"].as_str().unwrap(),
            f["state"].as_str().unwrap(),
            f["dts"].as_str().unwrap()
        ),
        f["canonical_utf8"]
    );
    assert_eq!(
        hex(f["canonical_utf8"].as_str().unwrap().as_bytes()),
        f["canonical_hex"]
    );
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let field = |k: &str| c["fields"][k].as_str();
        let now = c["now"].as_i64().unwrap();
        let checked = check_device_fields(field("dk"), field("dts"), field("dsig"), now);
        if let Some(code) = c["expect"]["code"].as_str() {
            let err = checked.expect_err(name);
            assert_eq!(err.code().as_str(), code, "{name}");
            if let Some(t) = c["expect"]["server_time"].as_i64() {
                assert_eq!(
                    err,
                    DeviceFieldError::TimestampSkewed { server_time: t },
                    "{name}"
                );
            }
        } else {
            checked.unwrap_or_else(|e| panic!("{name}: field checks must pass, got {e:?}"));
            let verified = verify_device_signature(
                field("host").unwrap(),
                field("pk").unwrap(),
                field("state").unwrap(),
                field("dts").unwrap(),
                field("dk").unwrap(),
                field("dsig").unwrap(),
            );
            assert_eq!(Some(verified), c["expect"]["verified"].as_bool(), "{name}");
        }
    }
}

#[test]
fn the_consent_cookie_reproduces_byte_for_byte() {
    let f = fixture("handoff/consent-cookie.json");
    let key = unhex(f["key_hex"].as_str().unwrap());
    let kv = f["kv"].as_u64().unwrap() as u32;
    let (host, fp24, iat) = (
        f["host"].as_str().unwrap(),
        f["fp24"].as_str().unwrap(),
        f["iat"].as_i64().unwrap(),
    );
    assert_eq!(consent_mac_input(host, fp24, iat, kv), f["mac_in_utf8"]);
    assert_eq!(
        hex(consent_mac_input(host, fp24, iat, kv).as_bytes()),
        f["mac_in_hex"]
    );
    assert_eq!(consent_mac(&key, host, fp24, iat, kv), f["mac"]);
    let value = build_consent_cookie(&key, kv, host, fp24, iat);
    assert_eq!(value, f["value"]);
    assert_eq!(
        consent_set_cookie(&value, MACHINE_HANDOFF_PATH),
        f["set_cookie"]["machine"]
    );
    assert_eq!(
        consent_set_cookie(&value, "/v1/handoff"),
        f["set_cookie"]["control_plane"]
    );
    let wk = &f["worker_key"];
    assert_eq!(wk["salt_utf8"], "yaran-cloud");
    assert_eq!(wk["info_utf8"], "v1/handoff_consent");
    assert_eq!(
        hex(&worker_consent_key(&unhex(
            wk["data_key_hex"].as_str().unwrap()
        ))),
        wk["key_hex"]
    );
    for c in f["verify_cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let got = verify_consent_cookie(
            c["value"].as_str().unwrap(),
            c["host"].as_str().unwrap(),
            &key,
            c["current_kv"].as_u64().unwrap() as u32,
            c["now"].as_i64().unwrap(),
        );
        match c["expect_reason"].as_str() {
            None => assert_eq!(got.as_deref(), Ok(fp24), "{name}"),
            Some(reason) => assert_eq!(got.map_err(CookieRejection::as_str), Err(reason), "{name}"),
        }
    }
}

#[test]
fn the_skip_rule_agrees_with_every_row() {
    let f = fixture("handoff/remembered-consent.json");
    let key = unhex(f["key_hex"].as_str().unwrap());
    for row in f["rows"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let input = RememberedInput {
            side: match row["side"].as_str().unwrap() {
                "worker" => ConsentSide::Worker,
                "yaran" => ConsentSide::Yaran,
                other => panic!("{name}: unknown side {other}"),
            },
            cookie: row["cookie"].as_str(),
            host: f["host"].as_str().unwrap(),
            dk_fp24: f["dk_fp24"].as_str().unwrap(),
            verified: row["verified"].as_bool().unwrap(),
            dts_fresh: row["dts_fresh"].as_bool().unwrap(),
            device_revoked: row["device_revoked"].as_bool().unwrap(),
            key: &key,
            current_kv: f["current_kv"].as_u64().unwrap() as u32,
            now: f["now"].as_i64().unwrap(),
        };
        let expect = match row["expect"].as_str().unwrap() {
            "skip" => ConsentDecision::Skip,
            _ => ConsentDecision::ConsentPage,
        };
        assert_eq!(decide_remembered(&input), expect, "{name}");
        assert!(
            expect == ConsentDecision::ConsentPage || input.verified,
            "{name}: a skip needs a verified signature"
        );
        assert_eq!(
            consent_sets_cookie(HandoffDecision::Continue, input.verified),
            row["continue_sets_cookie"],
            "{name}"
        );
        assert!(
            !consent_sets_cookie(HandoffDecision::Cancel, input.verified),
            "{name}"
        );
    }
}
