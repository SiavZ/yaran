//! Route tests for the Yaran Cloud routes, against a mock control plane.
//!
//! A fake "browser" either GETs the loopback callback named in the authorize URL (a
//! browser on this machine) or posts its landing address to `login/complete` (a
//! browser elsewhere). Covers status, start then complete both ways, a rejected
//! paste, an early failure, supersede, cancel, logout, rotate, and the secrets
//! acceptance (no credential secret in the raw config or the bootstrap).
//!
//! - Every engine is a headless test engine rooted in a scratch dir; nothing touches
//!   the network beyond loopback.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_routes_tests.rs
//! ├── cloud_routes
//! ├── test_support
//! ├── yaran-core::cloud::credentials
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::test_support
//! └── yaran-core::test_scratch
//! External: axum, reqwest, serde_json, std, tokio, tower
//!
//! Used by:
//! cloud_routes_tests.rs
//! └── cloud_routes
//! <module-headers:end>

use std::collections::HashMap;
use std::io::{Read, Write};
use std::time::Duration;

use axum::Router;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;
use yaran_core::cloud::credentials;
use yaran_core::cloud::machine_api::test_api_factory;
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::test_support::{
    MockResponse, MockWorker, SAMPLE_HOSTNAME, SAMPLE_ORG, SAMPLE_TUNNEL_ID, pair_sample,
    sample_claim,
};
use yaran_core::test_scratch::ScratchDir;

use super::{CloudState, router};
use crate::test_support::test_engine_handle;

const CODE: &str = "pppppppppppppppppppppppppppppppppppppppppp1";

fn meta(min: i64) -> serde_json::Value {
    serde_json::json!({
        "service": "yaran-cloud", "protocol": {"min": min, "max": min.max(1)}, "setup": "closed",
        "org": {"name": "Example Org", "url": SAMPLE_ORG},
        "access": {"team_domain": "team.cloudflareaccess.com"}, "worker": {"version": "1.0.0"},
        "capabilities": [], "push": {"enabled": false, "vapid_public_key": null}
    })
}

/// A control plane that answers meta, claim, unpair and rotate.
fn worker(min_protocol: i64) -> MockWorker {
    MockWorker::start(move |req| match req.path.as_str() {
        "/v1/meta" => MockResponse::json(200, meta(min_protocol)),
        "/v1/machine/claim" => {
            MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
        }
        "/v1/machine/unpair" => MockResponse::json(
            202,
            serde_json::json!({"machine_id": yaran_core::cloud::test_support::SAMPLE_MACHINE_ID, "state": "tearing_down"}),
        ),
        "/v1/machine/rotate" => MockResponse::json(
            200,
            serde_json::json!({"tunnel": {"id": SAMPLE_TUNNEL_ID, "token": "t2", "token_version": 2}, "rotated": true}),
        ),
        _ => MockResponse::error(404, "not_found", "nope"),
    })
}

fn app(w: &MockWorker) -> (ScratchDir, Router, CloudPaths) {
    let tmp = ScratchDir::new();
    let state = CloudState::new(
        test_engine_handle(tmp.path()),
        Some(test_api_factory(w.base_url())),
    );
    let paths = CloudPaths::from_root(tmp.path());
    (tmp, router(state), paths)
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, String) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(axum::body::Body::from(if method == "GET" {
            String::new()
        } else {
            body.to_string()
        }))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn json(app: &Router, method: &str, uri: &str, body: serde_json::Value) -> serde_json::Value {
    let (status, text) = call(app, method, uri, body).await;
    assert!(status.is_success(), "{uri}: {status} {text}");
    serde_json::from_str(&text).unwrap()
}

async fn start(app: &Router) -> serde_json::Value {
    json(
        app,
        "POST",
        "/api/v1/cloud/login/start",
        serde_json::json!({"org_url": SAMPLE_ORG}),
    )
    .await
}

fn query_of(url: &str) -> HashMap<String, String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

/// The landing address a browser reaches after approving.
fn landing(authorize_url: &str) -> String {
    let q = query_of(authorize_url);
    format!("{}?code={CODE}&state={}", q["callback"], q["state"])
}

/// A browser on this machine: GET the loopback callback.
async fn browser_hits_loopback(authorize_url: &str) {
    let q = query_of(authorize_url);
    let addr = q["callback"]
        .trim_start_matches("http://")
        .trim_end_matches("/callback")
        .to_string();
    let request = format!(
        "GET /callback?code={CODE}&state={} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        q["state"]
    );
    tokio::task::spawn_blocking(move || {
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
    })
    .await
    .unwrap();
}

async fn status(app: &Router) -> serde_json::Value {
    json(app, "GET", "/api/v1/cloud/status", serde_json::Value::Null).await
}

/// Poll status until `done` holds (the login finishes on its own thread).
async fn wait_for(app: &Router, done: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
    for _ in 0..100 {
        let s = status(app).await;
        if done(&s) {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!(
        "status never reached the expected state: {}",
        status(app).await
    );
}

#[tokio::test]
async fn status_reports_unpaired_with_no_login_and_no_secrets() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let s = status(&app).await;
    assert_eq!(s["paired"], false);
    assert_eq!(s["default_org_url"], "");
    assert!(s["active_login"].is_null());

    let creds = pair_sample(&paths, SAMPLE_ORG);
    let (_, text) = call(&app, "GET", "/api/v1/cloud/status", serde_json::Value::Null).await;
    let s: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(s["paired"], true);
    assert_eq!(s["hostname"], SAMPLE_HOSTNAME);
    for secret in [
        &creds.tunnel_token,
        &creds.machine_key_pkcs8,
        &creds.handoff_consent_key,
    ] {
        assert!(!text.contains(secret.as_str()), "status leaked a secret");
    }
}

#[tokio::test]
async fn start_then_a_local_browser_pairs_through_the_loopback() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let login = start(&app).await;
    assert_eq!(login["org_name"], "Example Org");
    let url = login["authorize_url"].as_str().unwrap();
    assert!(url.contains("/v1/pair/authorize?"));
    assert_eq!(query_of(url)["origin_port"], "3890");
    assert_eq!(login["fingerprint"].as_str().unwrap().len(), 29);
    // A reopened dialog finds the same login.
    assert_eq!(
        status(&app).await["active_login"]["login_id"],
        login["login_id"]
    );

    browser_hits_loopback(url).await;
    // The credentials land a moment before the login is retired; wait for both.
    let s = wait_for(&app, |s| s["paired"] == true && s["active_login"].is_null()).await;
    assert_eq!(s["hostname"], SAMPLE_HOSTNAME);
    assert!(s["active_login"].is_null());
    assert!(credentials::read(&paths).unwrap().is_some());
}

#[tokio::test]
async fn a_remote_browser_completes_by_pasting_its_landing_address() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let login = start(&app).await;
    let id = login["login_id"].clone();

    let (code, reason) = call(
        &app,
        "POST",
        "/api/v1/cloud/login/complete",
        serde_json::json!({"login_id": id, "callback_url": "http://127.0.0.1:1/callback?code=x&state=y"}),
    )
    .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY, "{reason}");
    assert!(!reason.is_empty());

    let done = json(
        &app,
        "POST",
        "/api/v1/cloud/login/complete",
        serde_json::json!({"login_id": id, "callback_url": landing(login["authorize_url"].as_str().unwrap())}),
    )
    .await;
    assert_eq!(done["finished"], true);
    assert_eq!(
        credentials::read(&paths).unwrap().unwrap().hostname,
        SAMPLE_HOSTNAME
    );
}

#[tokio::test]
async fn an_early_failure_answers_the_outcome_sentence() {
    let w = worker(9);
    let (_tmp, app, _paths) = app(&w);
    let (code, text) = call(
        &app,
        "POST",
        "/api/v1/cloud/login/start",
        serde_json::json!({"org_url": SAMPLE_ORG}),
    )
    .await;
    assert_eq!(code, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text.contains("protocol versions"), "{text}");
    assert!(status(&app).await["active_login"].is_null());
}

#[tokio::test]
async fn a_new_start_supersedes_the_old_login() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let first = start(&app).await;
    let second = start(&app).await;
    assert_ne!(first["login_id"], second["login_id"]);
    assert_eq!(
        status(&app).await["active_login"]["login_id"],
        second["login_id"]
    );

    let (code, _) = call(
        &app,
        "POST",
        "/api/v1/cloud/login/complete",
        serde_json::json!({"login_id": first["login_id"], "callback_url": landing(first["authorize_url"].as_str().unwrap())}),
    )
    .await;
    assert_eq!(code, StatusCode::CONFLICT);
    // The cancelled first login's end must not clear the second one.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(
        status(&app).await["active_login"]["login_id"],
        second["login_id"]
    );

    let done = json(
        &app,
        "POST",
        "/api/v1/cloud/login/complete",
        serde_json::json!({"login_id": second["login_id"], "callback_url": landing(second["authorize_url"].as_str().unwrap())}),
    )
    .await;
    assert_eq!(done["finished"], true);
    assert!(credentials::read(&paths).unwrap().is_some());
}

#[tokio::test]
async fn cancel_ends_the_login() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let login = start(&app).await;
    let (code, _) = call(
        &app,
        "POST",
        "/api/v1/cloud/login/cancel",
        serde_json::json!({"login_id": login["login_id"]}),
    )
    .await;
    assert_eq!(code, StatusCode::NO_CONTENT);
    assert!(status(&app).await["active_login"].is_null());
    assert!(credentials::read(&paths).unwrap().is_none());
}

#[tokio::test]
async fn logout_unpairs_and_deletes_the_credentials() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let reply = json(
        &app,
        "POST",
        "/api/v1/cloud/logout",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(reply["ok"], true, "not paired is the state already held");
    assert!(reply["message"].as_str().unwrap().contains("not paired"));

    pair_sample(&paths, SAMPLE_ORG);
    let reply = json(
        &app,
        "POST",
        "/api/v1/cloud/logout",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(reply["ok"], true);
    assert!(
        reply["message"]
            .as_str()
            .unwrap()
            .contains("no longer paired")
    );
    assert!(credentials::read(&paths).unwrap().is_none());
    assert!(w.requests().iter().any(|r| r.path == "/v1/machine/unpair"));
}

#[tokio::test]
async fn rotate_rewrites_the_token_and_keeps_the_consent_key() {
    let w = worker(1);
    let (_tmp, app, paths) = app(&w);
    let before = pair_sample(&paths, SAMPLE_ORG);
    let reply = json(
        &app,
        "POST",
        "/api/v1/cloud/rotate",
        serde_json::Value::Null,
    )
    .await;
    assert_eq!(reply["ok"], true);
    assert!(reply["message"].as_str().unwrap().contains("was rotated"));
    let after = credentials::read(&paths).unwrap().unwrap();
    assert_eq!(after.token_version, 2);
    assert_eq!(after.handoff_consent_key, before.handoff_consent_key);
}

/// Acceptance: no credential secret reaches the raw config or the bootstrap.
#[tokio::test]
async fn the_raw_config_and_the_bootstrap_carry_no_cloud_secret() {
    let (tmp, app) = crate::test_support::router_no_auth();
    let creds = pair_sample(&CloudPaths::from_root(tmp.path()), SAMPLE_ORG);
    for uri in ["/api/v1/config/raw", "/api/v1/bootstrap"] {
        let (code, text) = call(&app, "GET", uri, serde_json::Value::Null).await;
        assert_eq!(code, StatusCode::OK, "{uri}");
        for secret in [
            &creds.tunnel_token,
            &creds.machine_key_pkcs8,
            &creds.handoff_consent_key,
        ] {
            assert!(
                !text.contains(secret.as_str()),
                "{uri} leaked a cloud secret"
            );
        }
    }
    // The production merge serves the cloud routes too.
    let (code, _) = call(&app, "GET", "/api/v1/cloud/status", serde_json::Value::Null).await;
    assert_eq!(code, StatusCode::OK);
}
