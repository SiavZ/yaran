//! Shared harness for the cloud ingress and handoff tests: an app built by `build_app`
//! around a `CloudIngress` with a fixture JWKS, a fixed clock and a fake consent-key
//! source, a tracing capture, and the phone side of a handoff (device key, recipient
//! key, request building, envelope opening).
//!
//! - Test-only (`#[cfg(test)]`); never touches the network beyond loopback.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_test_support.rs
//! ├── cloud_ingress
//! ├── cloud_jwks_cache
//! ├── server
//! ├── test_support
//! ├── yaran-core::cloud::access_jwks
//! ├── yaran-core::cloud::protocol::concat_kdf
//! ├── yaran-core::cloud::protocol::handoff_consent
//! ├── yaran-core::cloud::protocol::rules
//! └── yaran-core::test_scratch
//! External: axum, ring, serde_json, std, tower, tracing, tracing_subscriber
//!
//! Used by:
//! cloud_test_support.rs
//! ├── cloud_consent_tests
//! ├── cloud_handoff_tests
//! ├── cloud_ingress_tests
//! ├── cloud_loop::live_cloud_mode_tests
//! ├── cloud_mode
//! └── crate
//! <module-headers:end>

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, agree_ephemeral};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use serde_json::Value;
use tower::ServiceExt;
use yaran_core::cloud::access_jwks::Jwks;
use yaran_core::cloud::protocol::concat_kdf::concat_kdf;
use yaran_core::cloud::protocol::handoff_consent::handoff_device_canonical;
use yaran_core::cloud::protocol::rules::{b64url_decode, b64url_encode};
use yaran_core::test_scratch::ScratchDir;

use crate::cloud_ingress::{
    CloudBindingInput, CloudIngress, ConsentKey, ConsentKeySource, IngressSettings,
};
use crate::cloud_jwks_cache::tests::{FakeSource, fixture_jwks};
use crate::server::{RouterParams, build_app};

pub(crate) const HOST: &str = "laptop-ada.example.com";
pub(crate) const CALLBACK: &str = "https://app.example.com/auth/callback";

pub(crate) fn fx(path: &str) -> Value {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../cloud/protocol/");
    serde_json::from_str(&std::fs::read_to_string(format!("{root}{path}")).unwrap()).unwrap()
}

pub(crate) fn token(name: &str) -> String {
    let t = fx("fixtures/access-jwt/tokens.json");
    let case = t["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name);
    case.unwrap()["token"].as_str().unwrap().to_string()
}

pub(crate) fn fixture_now() -> i64 {
    fx("fixtures/access-jwt/tokens.json")["now"]
        .as_i64()
        .unwrap()
}

#[derive(Default)]
pub(crate) struct FakeConsent(pub Mutex<Option<ConsentKey>>);

impl ConsentKeySource for FakeConsent {
    fn read_handoff_consent_key(&self) -> Result<Option<ConsentKey>, String> {
        Ok(self.0.lock().unwrap().clone())
    }
}

pub(crate) struct Harness {
    _tmp: ScratchDir,
    pub app: Router,
    pub ingress: CloudIngress,
    pub clock: Arc<AtomicI64>,
    pub consent: Arc<FakeConsent>,
}

pub(crate) fn binding_input(host: &str) -> CloudBindingInput {
    let t = fx("fixtures/access-jwt/tokens.json");
    CloudBindingInput {
        hostname: host.to_string(),
        team_domain: t["team_domain"].as_str().unwrap().to_string(),
        aud: t["aud"].as_str().unwrap().to_string(),
        owner_email: t["owner_email"].as_str().unwrap().to_string(),
    }
}

/// An app bound to `host` (unless `None`), the clock at the fixture's `now`.
pub(crate) fn harness_with(host: Option<&str>, jwks: Result<Jwks, String>) -> Harness {
    let tmp = ScratchDir::new();
    let clock = Arc::new(AtomicI64::new(fixture_now()));
    let consent = Arc::new(FakeConsent::default());
    let c = Arc::clone(&clock);
    let ingress = CloudIngress::with_parts(
        FakeSource::new(vec![jwks.map(|j| (j, None))]),
        consent.clone(),
        Arc::new(move || UNIX_EPOCH + Duration::from_secs(c.load(Ordering::SeqCst) as u64)),
    );
    ingress.update_settings(IngressSettings {
        app_callback_urls: vec![CALLBACK.to_string()],
        ..IngressSettings::default()
    });
    if let Some(host) = host {
        ingress.bind(binding_input(host), Box::new(|_| {})).unwrap();
    }
    let probe = Router::new().route("/probe", axum::routing::post(|| async { "ok" }));
    let app = build_app(
        crate::test_support::test_engine_handle(tmp.path()),
        probe,
        RouterParams::plain_http()
            .with_host_allowlist(vec!["127.0.0.1".parse().unwrap()], vec![], false)
            .with_cloud_ingress(ingress.clone()),
    );
    Harness {
        _tmp: tmp,
        app,
        ingress,
        clock,
        consent,
    }
}

/// An unbound ingress whose key fetches answer from the fixture, so a test that binds it
/// never reaches the network.
pub(crate) fn offline_ingress() -> CloudIngress {
    CloudIngress::with_parts(
        FakeSource::new(vec![Ok((fixture_jwks("jwks.json"), None))]),
        Arc::new(FakeConsent::default()),
        Arc::new(std::time::SystemTime::now),
    )
}

pub(crate) fn harness() -> Harness {
    harness_with(Some(HOST), Ok(fixture_jwks("jwks.json")))
}

pub(crate) async fn send(app: &Router, request: Request<Body>) -> Response<Body> {
    app.clone().oneshot(request).await.unwrap()
}

pub(crate) fn request(
    method: &str,
    uri: &str,
    host: &str,
    jwt: Option<&str>,
) -> axum::http::request::Builder {
    let b = Request::builder()
        .method(method)
        .uri(uri)
        .header("Host", host);
    match jwt {
        Some(jwt) => b.header("Cf-Access-Jwt-Assertion", jwt),
        None => b,
    }
}

pub(crate) async fn text(response: Response<Body>) -> String {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

pub(crate) fn refusal(response: &Response<Body>) -> Option<&str> {
    response
        .headers()
        .get("Yaran-Refusal")
        .and_then(|v| v.to_str().ok())
}

/// Collects every tracing field the code under test logs, on this thread.
#[derive(Clone, Default)]
pub(crate) struct Captured(pub Arc<Mutex<Vec<String>>>);

struct Visitor<'a>(&'a mut Vec<String>);

impl tracing::field::Visit for Visitor<'_> {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0.push(format!("{}={value:?}", field.name()));
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Captured {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut lines = self.0.lock().unwrap();
        event.record(&mut Visitor(&mut lines));
    }
}

impl Captured {
    pub(crate) fn install(&self) -> tracing::subscriber::DefaultGuard {
        use tracing_subscriber::layer::SubscriberExt;
        // With a single live dispatcher, tracing rebuilds callsite interest from
        // whichever thread rebuilds it, so a parallel test with no subscriber can
        // mark our callsites `never`. A second, permanent dispatcher forces the
        // rebuild to ask every live one.
        static KEEP: std::sync::OnceLock<tracing::Dispatch> = std::sync::OnceLock::new();
        KEEP.get_or_init(|| tracing::Dispatch::new(tracing_subscriber::registry()));
        let guard =
            tracing::subscriber::set_default(tracing_subscriber::registry().with(self.clone()));
        tracing::callsite::rebuild_interest_cache();
        guard
    }

    pub(crate) fn joined(&self) -> String {
        self.0.lock().unwrap().join("\n")
    }
}

pub(crate) fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b => format!("%{b:02X}"),
        })
        .collect()
}

pub(crate) fn form(pairs: &[(&str, String)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The fixture's device key, which signs whatever this test asks.
pub(crate) fn device() -> (EcdsaKeyPair, String) {
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

pub(crate) fn other_device() -> (EcdsaKeyPair, String) {
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let pair =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng).unwrap();
    let dk = b64url_encode(pair.public_key().as_ref());
    (pair, dk)
}

pub(crate) fn sign(pair: &EcdsaKeyPair, pk: &str, state: &str, dts: &str) -> String {
    let msg = handoff_device_canonical(HOST, pk, state, dts);
    b64url_encode(
        pair.sign(&SystemRandom::new(), msg.as_bytes())
            .unwrap()
            .as_ref(),
    )
}

pub(crate) fn recipient() -> (EphemeralPrivateKey, String) {
    let key = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).unwrap();
    let pk = b64url_encode(key.compute_public_key().unwrap().as_ref());
    (key, pk)
}

/// One handoff request: fresh `pk` and `state`, signed by `device` at the clock's now.
pub(crate) struct Ask {
    pub params: Vec<(&'static str, String)>,
    pub key: Option<EphemeralPrivateKey>,
}

pub(crate) fn ask(h: &Harness, device: &(EcdsaKeyPair, String), state: &str) -> Ask {
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
    pub(crate) fn set(mut self, name: &'static str, value: &str) -> Self {
        self.params.retain(|(k, _)| *k != name);
        self.params.push((name, value.into()));
        self
    }
    pub(crate) fn get(&self, name: &str) -> String {
        self.params
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

pub(crate) const STATE: &str = "c3RhdGUtZm9yLXRoZS1oYW5kb2ZmLXRlc3Q";

pub(crate) async fn get(h: &Harness, a: &Ask, host: &str, cookie: Option<&str>) -> Response<Body> {
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

pub(crate) fn csrf_of(page: &str) -> String {
    let at = page.find("name=\"csrf\" value=\"").expect("a csrf field") + 19;
    page[at..at + 43].to_string()
}

pub(crate) async fn post(
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
pub(crate) async fn consent(
    h: &Harness,
    a: &Ask,
    decision: &str,
    cookie: Option<&str>,
) -> Response<Body> {
    let page = get(h, a, HOST, None).await;
    assert_eq!(page.status(), StatusCode::OK);
    let csrf = csrf_of(&text(page).await);
    post(h, a, &csrf, decision, cookie).await
}

pub(crate) fn location(r: &Response<Body>) -> String {
    r.headers()
        .get("location")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

pub(crate) fn param(location: &str, name: &str) -> Option<String> {
    let query = location.split(['?', '#']).nth(1)?;
    query
        .split('&')
        .find_map(|kv| kv.strip_prefix(&format!("{name}=")[..]).map(str::to_string))
}

pub(crate) fn set_cookie(r: &Response<Body>) -> Option<String> {
    r.headers()
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().to_string())
}

/// Opens the envelope with the recipient key (ring ECDH, 02's Concat KDF, AES-GCM).
pub(crate) fn open(key: EphemeralPrivateKey, jwe: &str, state: &str) -> Value {
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

pub(crate) fn fixture_consent_key() -> ConsentKey {
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

pub(crate) fn cookie_header(value: &str) -> String {
    format!("__Secure-yaran-handoff-consent={value}")
}
