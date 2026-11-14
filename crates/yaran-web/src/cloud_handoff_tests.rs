//! Route-level tests for the handoff and sign-in routes (Phase 11 §7, D24): consent,
//! seal and in-test decrypt, the redirect allowlist fixture, the device-signature and
//! remembered-consent fixtures, the CSRF and rate-limit refusals, and the pages.
//!
//! - Test-only (`#[cfg(test)]`); the envelope is opened with ring ECDH + 02's Concat KDF.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_handoff_tests.rs
//! ├── cloud_ingress
//! ├── cloud_ingress_tests
//! ├── handoff_consent_page
//! └── yaran_core::cloud::protocol
//! External: axum, ring, serde_json, std
//!
//! Used by:
//! cloud_handoff_tests.rs
//! └── lib
//! <module-headers:end>

use std::sync::atomic::Ordering;

use axum::body::Body;
use axum::http::{Response, StatusCode};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::Value;
use yaran_core::cloud::protocol::concat_kdf::concat_kdf;
use yaran_core::cloud::protocol::handoff_consent::handoff_device_canonical;
use yaran_core::cloud::protocol::rules::{b64url_decode, b64url_encode};

use crate::cloud_ingress::ConsentKey;
use crate::cloud_ingress_tests::{
    CALLBACK, Captured, HOST, Harness, binding_input, fixture_now, fx, harness, refusal, request,
    send, text, token,
};

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect()
}

fn form(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The fixture's device key, which signs whatever this test asks.
fn device() -> (EcdsaKeyPair, String) {
    let f = fx("fixtures/sig/handoff-device-signature.json");
    let dk = f["dk"].as_str().unwrap().to_string();
    let d = b64url_decode(f["device_jwk"]["d"].as_str().unwrap()).unwrap();
    let pair = EcdsaKeyPair::from_private_key_and_public_key(
        &ECDSA_P256_SHA256_FIXED_SIGNING,
        &d,
        &b64url_decode(&dk).unwrap(),
        &SystemRandom::new(),
    )
    .unwrap();
    (pair, dk)
}

fn other_device() -> (EcdsaKeyPair, String) {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let dk = b64url_encode(pair.public_key().as_ref());
    (pair, dk)
}

fn sign(pair: &EcdsaKeyPair, pk: &str, state: &str, dts: &str) -> String {
    let msg = handoff_device_canonical(HOST, pk, state, dts);
    b64url_encode(
        pair.sign(&SystemRandom::new(), msg.as_bytes())
            .unwrap()
            .as_ref(),
    )
}

fn recipient() -> (EphemeralPrivateKey, String) {
    let key = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap();
    let pk = b64url_encode(key.compute_public_key().unwrap().as_ref());
    (key, pk)
}

/// One handoff request: fresh `pk` and `state`, signed by `device` at the clock's now.
struct Ask {
    params: Vec<(&'static str, String)>,
    key: Option<EphemeralPrivateKey>,
}

fn ask(h: &Harness, device: &(EcdsaKeyPair, String), state: &str) -> Ask {
    let (key, pk) = recipient();
    let dts = h.clock.load(Ordering::SeqCst).to_string();
    let dsig = sign(&device.0, &pk, state, &dts);
    let params = vec![
        ("v", "1".into()),
        ("pk", pk),
        ("state", state.into()),
        ("redirect", CALLBACK.into()),
        ("device", "Ada's <Pixel> 9".into()),
        ("dk", device.1.clone()),
        ("dts", dts),
        ("dsig", dsig),
    ];
    Ask {
        params,
        key: Some(key),
    }
}

impl Ask {
    fn set(mut self, name: &'static str, value: &str) -> Self {
        self.params.retain(|(k, _)| *k != name);
        self.params.push((name, value.into()));
        self
    }
    fn get(&self, name: &str) -> String {
        self.params
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

const STATE: &str = "c3RhdGUtZm9yLXRoZS1oYW5kb2ZmLXRlc3Q";

async fn get(h: &Harness, a: &Ask, host: &str, cookie: Option<&str>) -> Response<Body> {
    let mut b = request(
        "GET",
        &format!("/__yaran/handoff?{}", form(&a.params)),
        host,
        Some(&token("valid")),
    )
    .header(
        "User-Agent",
        "Mozilla/5.0 (Linux; Android 15) Chrome/131.0 Mobile",
    );
    if let Some(c) = cookie {
        b = b.header("Cookie", c);
    }
    send(&h.app, b.body(Body::empty()).unwrap()).await
}

fn csrf_of(page: &str) -> String {
    let at = page.find("name=\"csrf\" value=\"").expect("a csrf field") + 19;
    page[at..at + 43].to_string()
}

async fn post(
    h: &Harness,
    a: &Ask,
    csrf: &str,
    decision: &str,
    cookie: Option<&str>,
) -> Response<Body> {
    let keep = [
        "v", "pk", "state", "redirect", "build", "mode", "device", "dk",
    ];
    let mut pairs: Vec<_> = a
        .params
        .iter()
        .filter(|(k, _)| keep.contains(k))
        .cloned()
        .collect();
    pairs.push(("csrf", csrf.into()));
    pairs.push(("decision", decision.into()));
    let mut b = request("POST", "/__yaran/handoff", HOST, Some(&token("valid")))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Origin", format!("https://{HOST}"));
    if let Some(c) = cookie {
        b = b.header("Cookie", c);
    }
    send(&h.app, b.body(Body::from(form(&pairs))).unwrap()).await
}

/// GET then POST `decision` with the page's csrf.
async fn consent(h: &Harness, a: &Ask, decision: &str, cookie: Option<&str>) -> Response<Body> {
    let page = get(h, a, HOST, None).await;
    assert_eq!(page.status(), StatusCode::OK);
    let csrf = csrf_of(&text(page).await);
    post(h, a, &csrf, decision, cookie).await
}

fn location(r: &Response<Body>) -> String {
    r.headers()
        .get("location")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

fn param(location: &str, name: &str) -> Option<String> {
    let query = location.split(['?', '#']).nth(1)?;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{name}=")[..]).map(str::to_string))
}

fn set_cookie(r: &Response<Body>) -> Option<String> {
    r.headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().to_string())
}

/// Opens the envelope with the recipient key (ring ECDH, 02's Concat KDF, AES-GCM).
fn open(key: EphemeralPrivateKey, jwe: &str, state: &str) -> Value {
    let parts: Vec<&str> = jwe.split('.').collect();
    assert_eq!(parts.len(), 5);
    assert!(parts[1].is_empty(), "ECDH-ES direct has no encrypted key");
    let header: Value = serde_json::from_slice(&b64url_decode(parts[0]).unwrap()).unwrap();
    let mut epk = vec![4u8];
    epk.extend(b64url_decode(header["epk"]["x"].as_str().unwrap()).unwrap());
    epk.extend(b64url_decode(header["epk"]["y"].as_str().unwrap()).unwrap());
    let z = agree_ephemeral(key, &UnparsedPublicKey::new(&ECDH_P256, epk), |z| {
        z.to_vec()
    })
    .unwrap();
    let cek = concat_kdf(&z, "A256GCM", HOST.as_bytes(), state.as_bytes(), 256);
    let aead = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, &cek).unwrap());
    let iv: [u8; 12] = b64url_decode(parts[2]).unwrap().try_into().unwrap();
    let mut buf = b64url_decode(parts[3]).unwrap();
    buf.extend(b64url_decode(parts[4]).unwrap());
    let plain = aead
        .open_in_place(
            Nonce::assume_unique_for_key(iv),
            Aad::from(parts[0].as_bytes()),
            &mut buf,
        )
        .unwrap();
    serde_json::from_slice(plain).unwrap()
}

fn fixture_consent_key() -> ConsentKey {
    let f = fx("fixtures/handoff/consent-cookie.json");
    let hex = f["key_hex"].as_str().unwrap();
    let key: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    ConsentKey {
        key: key.try_into().unwrap(),
        version: f["kv"].as_u64().unwrap() as u32,
    }
}

fn cookie_header(value: &str) -> String {
    format!("__Secure-yaran-handoff-consent={value}")
}

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
}

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
