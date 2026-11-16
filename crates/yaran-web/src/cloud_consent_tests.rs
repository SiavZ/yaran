//! Route-level tests for remembered handoff consent (Phase 11 §7, D24): the four D24
//! fixtures of 02 driven through Y1/Y1b, and an end-to-end renewal whose logs are
//! checked for secrets.
//!
//! - Test-only (`#[cfg(test)]`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud_consent_tests.rs
//! ├── cloud_ingress
//! └── cloud_test_support
//! External: axum, std, tokio
//!
//! Used by:
//! cloud_consent_tests.rs
//! └── crate
//! <module-headers:end>

use std::sync::atomic::Ordering;

use axum::http::StatusCode;

use crate::cloud_ingress::ConsentKey;
use crate::cloud_test_support::*;

#[tokio::test]
async fn remembered_consent_runs_end_to_end_and_never_logs_a_secret() {
    let captured = Captured::default();
    let _guard = captured.install();
    let h = harness();
    *h.consent.0.lock().unwrap() = Some(fixture_consent_key());
    let r = consent(&h, &ask(&h, &device(), STATE), "continue", None).await;
    let line = set_cookie(&r).unwrap();
    assert_eq!(
        line,
        fx("fixtures/handoff/consent-cookie.json")["set_cookie"]["machine"]
    );
    let cookie = cookie_header(line.split(';').next().unwrap().split_once('=').unwrap().1);

    let renewal = ask(&h, &device(), "cmVuZXdhbC1zdGF0ZS1mb3ItdGhlLXRlc3Q");
    let r = get(&h, &renewal, HOST, Some(&cookie)).await;
    assert_eq!(r.status(), StatusCode::FOUND, "the skip seals at once");
    assert!(param(&location(&r), "jwe").is_some() && set_cookie(&r).is_none());

    let foreign = get(&h, &ask(&h, &other_device(), STATE), HOST, Some(&cookie)).await;
    assert_eq!(
        foreign.status(),
        StatusCode::OK,
        "another app's key gets the page"
    );
    let a = ask(&h, &device(), STATE);
    let wrong_sig = a.set(
        "dsig",
        &sign(
            &device().0,
            &ask(&h, &device(), STATE).get("pk"),
            STATE,
            &fixture_now().to_string(),
        ),
    );
    let r = get(&h, &wrong_sig, HOST, Some(&cookie)).await;
    assert_eq!(
        r.status(),
        StatusCode::OK,
        "a signature over another pk gets the page"
    );
    let r = post(&h, &wrong_sig, &csrf_of(&text(r).await), "continue", None).await;
    assert!(
        param(&location(&r), "jwe").is_some() && set_cookie(&r).is_none(),
        "unverified: no cookie"
    );

    // build and redirect are outside the signed string, so the signature still holds.
    let dev = ask(&h, &device(), STATE)
        .set("build", "dev")
        .set("redirect", "yaranapp://auth/callback");
    assert_eq!(
        get(&h, &dev, HOST, Some(&cookie)).await.status(),
        StatusCode::FOUND,
        "dev skips too"
    );

    let a = ask(&h, &device(), STATE);
    let csrf = csrf_of(&text(get(&h, &a, HOST, None).await).await);
    let swapped = Ask {
        params: a.params.clone(),
        key: None,
    }
    .set("dk", &other_device().1);
    let r = post(&h, &swapped, &csrf, "continue", None).await;
    assert_eq!(
        param(&location(&r), "error").as_deref(),
        Some("handoff_request_invalid")
    );
    assert!(set_cookie(&r).is_none());
    assert!(set_cookie(&consent(&h, &ask(&h, &device(), STATE), "cancel", None).await).is_none());

    *h.consent.0.lock().unwrap() = Some(ConsentKey {
        key: [7; 32],
        version: 4,
    });
    assert_eq!(
        get(&h, &ask(&h, &device(), STATE), HOST, Some(&cookie))
            .await
            .status(),
        StatusCode::OK,
        "rotated key"
    );
    let fresh =
        set_cookie(&consent(&h, &ask(&h, &device(), STATE), "continue", None).await).unwrap();
    assert!(
        fresh.starts_with("__Secure-yaran-handoff-consent=v1.4."),
        "{fresh}"
    );

    let logs = captured.joined();
    assert!(
        logs.contains("remembered") && logs.contains("explicit"),
        "{logs}"
    );
    for secret in [
        token("valid"),
        STATE.to_string(),
        cookie,
        renewal.get("dsig"),
        renewal.get("dk"),
    ] {
        assert!(
            !logs.contains(&secret[..secret.len().min(30)]),
            "a secret reached the log"
        );
    }
}

#[tokio::test]
async fn the_device_signature_fixture_holds_through_the_route() {
    let f = fx("fixtures/sig/handoff-device-signature.json");
    let cookie = cookie_header(
        fx("fixtures/handoff/consent-cookie.json")["value"]
            .as_str()
            .unwrap(),
    );
    let h = harness();
    *h.consent.0.lock().unwrap() = Some(fixture_consent_key());
    for c in f["cases"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let fields = &c["fields"];
        let host = fields["host"].as_str().unwrap();
        h.ingress
            .bind(binding_input(host), Box::new(|_| {}))
            .unwrap();
        h.clock.store(c["now"].as_i64().unwrap(), Ordering::SeqCst);
        let mut a = ask(&h, &device(), fields["state"].as_str().unwrap())
            .set("pk", fields["pk"].as_str().unwrap());
        a.params.retain(|(k, _)| !["dk", "dts", "dsig"].contains(k));
        for k in ["dk", "dts", "dsig"] {
            if let Some(v) = fields[k].as_str() {
                a = a.set(k, v);
            }
        }
        let r = get(&h, &a, host, Some(&cookie)).await;
        let (status, loc) = (r.status(), location(&r));
        match (
            c["expect"]["verified"].as_bool(),
            c["expect"]["code"].as_str(),
        ) {
            (Some(true), _) => assert!(
                status == StatusCode::FOUND && param(&loc, "jwe").is_some(),
                "{name}: {status} {loc}"
            ),
            (Some(false), _) => assert_eq!(status, StatusCode::OK, "{name}"),
            (None, Some(code)) => {
                assert_eq!(param(&loc, "error").as_deref(), Some(code), "{name}");
                let server_time = c["expect"]["server_time"].as_i64().map(|t| t.to_string());
                assert_eq!(param(&loc, "server_time"), server_time, "{name}");
            }
            other => panic!("{name}: unexpected expectation {other:?}"),
        }
    }
}

#[tokio::test]
async fn every_yaran_row_of_the_remembered_consent_fixture_holds() {
    let f = fx("fixtures/handoff/remembered-consent.json");
    let h = harness();
    *h.consent.0.lock().unwrap() = Some(fixture_consent_key());
    for row in f["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["side"] == "yaran")
    {
        let name = row["name"].as_str().unwrap();
        let mut a = ask(&h, &device(), STATE);
        if row["verified"] == false {
            let dsig = sign(
                &device().0,
                &a.get("pk"),
                "b3RoZXItc3RhdGUtZm9yLXRoZS10ZXN0",
                &a.get("dts"),
            );
            a = a.set("dsig", &dsig);
        }
        if row["dts_fresh"] == false {
            let stale = (fixture_now() - 301).to_string();
            let dsig = sign(&device().0, &a.get("pk"), STATE, &stale);
            a = a.set("dsig", &dsig).set("dts", &stale);
        }
        let cookie = row["cookie"].as_str().map(cookie_header);
        let r = get(&h, &a, HOST, cookie.as_deref()).await;
        if row["dts_fresh"] == false {
            assert_eq!(
                param(&location(&r), "error").as_deref(),
                Some("handoff_timestamp_skewed"),
                "{name}"
            );
        } else if row["expect"] == "skip" {
            assert!(param(&location(&r), "jwe").is_some(), "{name}");
        } else {
            assert_eq!(r.status(), StatusCode::OK, "{name}");
            let r = post(&h, &a, &csrf_of(&text(r).await), "continue", None).await;
            assert_eq!(
                set_cookie(&r).is_some(),
                row["continue_sets_cookie"] == true,
                "{name}"
            );
        }
    }
}

#[tokio::test]
async fn tampered_future_and_expired_cookies_get_the_page_and_are_not_cleared() {
    let f = fx("fixtures/handoff/consent-cookie.json");
    let h = harness();
    for c in f["verify_cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["expect_reason"].is_null())
    {
        let host = c["host"].as_str().unwrap();
        h.ingress
            .bind(binding_input(host), Box::new(|_| {}))
            .unwrap();
        h.clock.store(c["now"].as_i64().unwrap(), Ordering::SeqCst);
        let version = c["current_kv"].as_u64().unwrap() as u32;
        *h.consent.0.lock().unwrap() = Some(ConsentKey {
            version,
            ..fixture_consent_key()
        });
        let r = get(
            &h,
            &ask(&h, &device(), STATE),
            host,
            Some(&cookie_header(c["value"].as_str().unwrap())),
        )
        .await;
        assert_eq!(r.status(), StatusCode::OK, "{}", c["name"]);
        assert!(set_cookie(&r).is_none(), "{}", c["name"]);
    }
}
