//! Route-level tests for the handoff and sign-in routes (Phase 11 §7): consent, seal and
//! in-test decrypt, the redirect allowlist fixture, the CSRF, origin and rate-limit
//! refusals, the 404 off the cloud Host, and the pages.
//!
//! - Test-only (`#[cfg(test)]`); the envelope is opened with ring ECDH + 02's Concat KDF.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_handoff_tests.rs
//! ├── cloud_test_support
//! ├── handoff_consent_page
//! └── yaran-core::cloud::protocol::rules
//! External: axum, serde_json, std, tokio
//!
//! Used by:
//! cloud_handoff_tests.rs
//! └── crate
//! <module-headers:end>

use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::StatusCode;
use serde_json::Value;
use yaran_core::cloud::protocol::rules::{b64url_decode, b64url_encode};

use crate::cloud_test_support::*;

#[tokio::test]
async fn the_get_shows_a_consent_page_and_never_an_envelope() {
    let h = harness();
    let r = get(&h, &ask(&h, &device(), STATE), HOST, None).await;
    assert_eq!(r.status(), StatusCode::OK);
    let headers = format!("{:?}", r.headers());
    assert!(!headers.contains("jwe"), "{headers}");
    let csp = r.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        csp.contains("frame-ancestors 'none'")
            && csp.contains("form-action 'self' https://app.example.com;"),
        "{csp}"
    );
    assert_eq!(r.headers()["referrer-policy"], "same-origin");
    assert_eq!(r.headers()["cache-control"], "no-store");
    let page = text(r).await;
    assert!(!page.contains("jwe") && !page.contains("development build"));
    for chip in [
        "Ada&#39;s &lt;Pixel&gt; 9",
        HOST,
        "owner@example.com",
        "Chrome on Android",
    ] {
        assert!(
            page.contains(&format!("<code class=\"chip\">{chip}</code>")),
            "{chip}: {page}"
        );
    }
    assert!(!page.contains("<Pixel>"), "the device label renders inert");
    assert_eq!(csrf_of(&page).len(), 43);
}

#[tokio::test]
async fn continue_seals_the_owner_jwt_to_the_phones_key() {
    let h = harness();
    let mut a = ask(&h, &device(), STATE);
    let r = consent(&h, &a, "continue", None).await;
    assert_eq!(r.status(), StatusCode::SEE_OTHER);
    let loc = location(&r);
    assert!(
        loc.starts_with(&format!("{CALLBACK}?state={STATE}&jwe=")),
        "{loc}"
    );
    assert_eq!(r.headers()["referrer-policy"], "no-referrer");
    assert_eq!(r.headers()["pragma"], "no-cache");
    let payload = open(a.key.take().unwrap(), &param(&loc, "jwe").unwrap(), STATE);
    assert_eq!(payload["jwt"], token("valid"));
    assert_eq!(
        (payload["kind"].as_str(), payload["host"].as_str()),
        (Some("machine"), Some(HOST))
    );
    assert!(payload.get("cookie").is_none());
    assert_eq!(payload["iat"], fixture_now());
}

#[tokio::test]
async fn a_matching_access_cookie_rides_along_and_a_foreign_one_is_refused() {
    let h = harness();
    let mut a = ask(&h, &device(), STATE);
    let r = consent(
        &h,
        &a,
        "continue",
        Some(&format!("CF_Authorization={}", token("valid"))),
    )
    .await;
    let payload = open(
        a.key.take().unwrap(),
        &param(&location(&r), "jwe").unwrap(),
        STATE,
    );
    assert_eq!(payload["cookie"], token("valid"));
    let a = ask(&h, &device(), STATE);
    let r = consent(
        &h,
        &a,
        "continue",
        Some(&format!("CF_Authorization={}", token("other email"))),
    )
    .await;
    assert_eq!(
        param(&location(&r), "error").as_deref(),
        Some("handoff_request_invalid")
    );
    assert_eq!(param(&location(&r), "jwe"), None);
}

#[tokio::test]
async fn fragment_mode_cancel_and_csrf_misuse_get_their_answers() {
    let h = harness();
    let r = consent(
        &h,
        &ask(&h, &device(), STATE).set("mode", "fragment"),
        "continue",
        None,
    )
    .await;
    assert!(location(&r).starts_with(&format!("{CALLBACK}#state={STATE}&jwe=")));
    let r = consent(&h, &ask(&h, &device(), STATE), "cancel", None).await;
    assert_eq!(
        location(&r),
        format!("{CALLBACK}?state={STATE}&error=handoff_declined")
    );
    assert_eq!(set_cookie(&r), None);

    let a = ask(&h, &device(), STATE);
    let csrf = csrf_of(&text(get(&h, &a, HOST, None).await).await);
    assert!(
        param(
            &location(&post(&h, &a, &csrf, "continue", None).await),
            "jwe"
        )
        .is_some()
    );
    let reused = post(&h, &a, &csrf, "continue", None).await;
    assert_eq!(
        param(&location(&reused), "error").as_deref(),
        Some("handoff_request_invalid")
    );
    let never = post(&h, &a, &"A".repeat(43), "continue", None).await;
    assert_eq!(
        param(&location(&never), "error").as_deref(),
        Some("handoff_request_invalid")
    );

    for other in [
        ask(&h, &device(), "b3RoZXItc3RhdGUtZm9yLXRoZS10ZXN0"),
        ask(&h, &device(), STATE),
    ] {
        let csrf = csrf_of(&text(get(&h, &a, HOST, None).await).await);
        let r = post(&h, &other, &csrf, "continue", None).await;
        assert_eq!(
            param(&location(&r), "error").as_deref(),
            Some("handoff_request_invalid"),
            "other state/pk"
        );
    }
    let csrf = csrf_of(&text(get(&h, &a, HOST, None).await).await);
    h.clock.fetch_add(600, Ordering::SeqCst);
    let expired = post(&h, &a, &csrf, "continue", None).await;
    assert_eq!(
        param(&location(&expired), "error").as_deref(),
        Some("handoff_request_invalid")
    );
}

#[tokio::test]
async fn a_cross_origin_or_null_origin_post_is_refused_by_the_origin_check() {
    let h = harness();
    for origin in ["https://evil.example", "null"] {
        let r = send(
            &h.app,
            request("POST", "/__yaran/handoff", HOST, Some(&token("valid")))
                .header("Origin", origin)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(Body::from("v=1"))
                .unwrap(),
        )
        .await;
        assert_eq!(r.status(), StatusCode::FORBIDDEN, "{origin}");
    }
}

#[tokio::test]
async fn the_redirect_allowlist_fixture_holds_through_the_route() {
    let h = harness();
    let f = fx("fixtures/uri/handoff-redirect.json");
    assert_eq!(f["configured"][0], CALLBACK);
    for c in f["cases"].as_array().unwrap() {
        let mut a = ask(&h, &device(), STATE).set("redirect", c["redirect"].as_str().unwrap());
        if let Some(build) = c["build"].as_str() {
            a = a.set("build", build);
        }
        let r = get(&h, &a, HOST, None).await;
        let label = format!("{} {:?}", c["redirect"], c["build"]);
        if c["expect"] == true {
            assert_eq!(r.status(), StatusCode::OK, "{label}");
            let csp = r.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .to_string();
            let dev = c["build"] == "dev";
            assert_eq!(
                csp.contains("form-action 'self' yaranapp:;"),
                dev,
                "{label}"
            );
            assert_eq!(text(r).await.contains("development build"), dev, "{label}");
        } else {
            assert_eq!(r.status(), StatusCode::BAD_REQUEST, "{label}");
            assert!(r.headers().get("location").is_none(), "{label}");
            let body: Value = serde_json::from_str(&text(r).await).unwrap();
            assert_eq!(body["error"]["code"], "handoff_request_invalid", "{label}");
        }
    }
    let html = send(
        &h.app,
        request(
            "GET",
            "/__yaran/handoff?state=x",
            HOST,
            Some(&token("valid")),
        )
        .header("Accept", "text/html")
        .body(Body::empty())
        .unwrap(),
    )
    .await;
    assert_eq!(html.status(), StatusCode::BAD_REQUEST);
    assert!(text(html).await.contains("handoff_request_invalid"));
}

#[tokio::test]
async fn bad_points_and_versions_redirect_with_their_codes() {
    let h = harness();
    let (_, good) = recipient();
    let raw = b64url_decode(&good).unwrap();
    let mut off_curve = raw.clone();
    off_curve[64] ^= 1;
    let mut compressed = vec![2u8];
    compressed.extend(&raw[1..33]);
    for pk in [
        b64url_encode(&off_curve),
        b64url_encode(&compressed),
        b64url_encode(&raw[..64]),
        b64url_encode(&[&raw[..], &[0]].concat()),
        r#"{"kty":"EC","crv":"P-256"}"#.to_string(),
    ] {
        let r = get(&h, &ask(&h, &device(), STATE).set("pk", &pk), HOST, None).await;
        assert_eq!(r.status(), StatusCode::FOUND);
        assert_eq!(
            param(&location(&r), "error").as_deref(),
            Some("handoff_request_invalid"),
            "{pk}"
        );
    }
    for v in ["0", "2"] {
        let r = get(&h, &ask(&h, &device(), STATE).set("v", v), HOST, None).await;
        assert_eq!(
            location(&r),
            format!("{CALLBACK}?state={STATE}&error=protocol_unsupported&min=1&max=1")
        );
    }
}

#[tokio::test]
async fn the_thirteenth_continue_in_a_minute_is_rate_limited() {
    let captured = Captured::default();
    let _guard = captured.install();
    let h = harness();
    for _ in 0..12 {
        assert!(
            param(
                &location(&consent(&h, &ask(&h, &device(), STATE), "continue", None).await),
                "jwe"
            )
            .is_some()
        );
    }
    let r = consent(&h, &ask(&h, &device(), STATE), "continue", None).await;
    assert_eq!(
        param(&location(&r), "error").as_deref(),
        Some("rate_limited")
    );
    assert_eq!(r.headers()["retry-after"], "60");
    // Like every other refusal, the owner can find this one in yaran.log.
    let logged = captured.joined();
    assert!(logged.contains("code=\"rate_limited\""), "{logged}");
    assert!(logged.contains("retry_after_secs=60"), "{logged}");
    assert!(
        !logged.contains(STATE),
        "the request's own values stay out: {logged}"
    );
}

#[tokio::test]
async fn the_routes_exist_only_behind_access() {
    let h = harness();
    let a = ask(&h, &device(), STATE);
    for (method, uri) in [
        ("GET", format!("/__yaran/handoff?{}", form(&a.params))),
        ("POST", "/__yaran/handoff".into()),
        ("GET", "/__yaran/signed-in".into()),
    ] {
        let r = send(
            &h.app,
            request(method, &uri, "localhost", None)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND, "{method} {uri}");
    }
    let r = send(
        &h.app,
        request("GET", "/__yaran/signed-in", HOST, Some(&token("valid")))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!((r.status(), refusal(&r)), (StatusCode::OK, None));
    assert_eq!(r.headers()["cache-control"], "no-store");
    let spa = |uri: &str| {
        request("GET", uri, "localhost", None)
            .body(Body::empty())
            .unwrap()
    };
    let unknown = send(&h.app, spa("/__yaran/x")).await.status();
    assert_eq!(
        unknown,
        send(&h.app, spa("/some/client/route")).await.status(),
        "still the SPA fallback"
    );
}

#[test]
fn the_platform_comes_from_the_app_token_then_the_browser_and_is_otherwise_omitted() {
    use crate::handoff_consent_page::platform_label;
    let app = "Mozilla/5.0 (iPhone) YaranApp/1.2.3 (ios; phone)";
    assert_eq!(
        platform_label(Some(app)).as_deref(),
        Some("yaran app on an iOS phone")
    );
    let browser = "Mozilla/5.0 (Linux; Android 15) Chrome/131.0 Mobile";
    assert_eq!(
        platform_label(Some(browser)).as_deref(),
        Some("Chrome on Android")
    );
    assert_eq!(platform_label(None), None);
    assert_eq!(platform_label(Some("  ")), None);
}
