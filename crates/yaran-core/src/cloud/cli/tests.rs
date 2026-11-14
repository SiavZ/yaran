//! Tests for `yaran cloud` through `run_with`, against a mock Worker.
//!
//! <module-headers:begin>
//! <module-headers:end>

use super::*;
use crate::cloud::credentials;
use crate::cloud::machine_api::test_api_factory;
use crate::cloud::test_support::{
    MockResponse, MockWorker, RecordedRequest, SAMPLE_ORG, pair_sample,
};

struct Run {
    code: i32,
    out: String,
}

fn run(
    root: &std::path::Path,
    worker: &MockWorker,
    is_tty: bool,
    stdin: &str,
    args: &[&str],
) -> Run {
    let deps = CloudDeps {
        paths: CloudPaths::from_root(root),
        config: CloudConfig::default(),
        server_port: 3890,
        api: test_api_factory(worker.base_url()),
        is_tty,
        open_browser: Box::new(|_| Err("no browser in tests".into())),
        pickup_wait: Duration::ZERO,
    };
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    let code = run_with(
        &args,
        deps,
        Box::new(std::io::Cursor::new(stdin.to_string())),
        &mut out,
    );
    Run {
        code,
        out: String::from_utf8(out).unwrap(),
    }
}

fn worker(
    handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
) -> MockWorker {
    MockWorker::start(handler)
}

fn quiet() -> MockWorker {
    worker(|_| MockResponse::error(500, "internal", "should not be called"))
}

#[test]
fn help_never_needs_state_and_names_every_verb() {
    let root = tempfile::tempdir().unwrap();
    let r = run(root.path(), &quiet(), false, "", &["--help"]);
    assert_eq!(r.code, 0);
    for verb in ["login", "logout", "status", "rotate", "pair-phone"] {
        assert!(r.out.contains(verb), "{verb}");
    }
    let r = run(root.path(), &quiet(), false, "", &["status", "--help"]);
    assert!(r.out.contains("Exit codes") && r.out.contains("5 revoked"));
    let r = run(root.path(), &quiet(), false, "", &["frobnicate"]);
    assert_eq!(r.code, 2);
    assert!(r.out.contains("yaran cloud --help"));
}

#[test]
fn logout_refuses_off_a_tty_without_yes() {
    let root = tempfile::tempdir().unwrap();
    let w = quiet();
    pair_sample(&CloudPaths::from_root(root.path()), SAMPLE_ORG);
    let r = run(root.path(), &w, false, "", &["logout"]);
    assert_eq!(r.code, 2);
    assert!(r.out.contains("--yes"));
    assert!(w.requests().is_empty());
    let r = run(root.path(), &w, true, "n\n", &["logout"]);
    assert_eq!(r.code, 1);
    assert!(
        credentials::read(&CloudPaths::from_root(root.path()))
            .unwrap()
            .is_some()
    );
}

#[test]
fn logout_unpairs_and_deletes_on_202_and_on_410() {
    for (status, body) in [
        (
            202,
            serde_json::json!({"machine_id": crate::cloud::test_support::SAMPLE_MACHINE_ID, "state": "tearing_down"}),
        ),
        (
            410,
            serde_json::json!({"error": {"code": "machine_revoked", "message": "gone", "retryable": false}, "request_id": "r"}),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let paths = CloudPaths::from_root(root.path());
        pair_sample(&paths, SAMPLE_ORG);
        let w = worker(move |_| MockResponse::json(status, body.clone()));
        let r = run(root.path(), &w, true, "y\n", &["logout"]);
        assert_eq!(r.code, 0, "{}", r.out);
        assert!(r.out.contains("no longer paired"));
        assert_eq!(w.requests()[0].path, "/v1/machine/unpair");
        assert_eq!(credentials::read(&paths).unwrap(), None);
    }
}

#[test]
fn logout_keeps_credentials_on_network_failure_unless_local_only() {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    pair_sample(&paths, SAMPLE_ORG);
    let w = worker(|_| MockResponse::error(503, "unavailable", "down"));
    let r = run(root.path(), &w, false, "", &["logout", "--yes"]);
    assert_eq!(r.code, 1);
    assert!(r.out.contains("--local-only"));
    assert!(credentials::read(&paths).unwrap().is_some());
    let r = run(
        root.path(),
        &w,
        false,
        "",
        &["logout", "--yes", "--local-only"],
    );
    assert_eq!(r.code, 0);
    assert!(r.out.contains("stays valid until an administrator removes"));
    assert_eq!(credentials::read(&paths).unwrap(), None);
    assert_eq!(w.requests().len(), 1);
    let r = run(root.path(), &w, false, "", &["logout", "--yes"]);
    assert!(r.out.contains("not paired") && r.code == 0);
}

#[test]
fn rotate_consent_key_is_local_and_keeps_the_tunnel_token() {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    let w = quiet();
    let r = run(
        root.path(),
        &w,
        false,
        "",
        &["rotate", "--consent-key", "--yes"],
    );
    assert!(r.out.contains("not paired"));
    let before = pair_sample(&paths, SAMPLE_ORG);
    let r = run(root.path(), &w, false, "", &["rotate", "--consent-key"]);
    assert_eq!(r.code, 2);
    let r = run(
        root.path(),
        &w,
        false,
        "",
        &["rotate", "--consent-key", "--yes"],
    );
    assert_eq!(r.code, 0);
    assert!(r.out.contains("Phones will be asked to confirm again"));
    let after = credentials::read(&paths).unwrap().unwrap();
    assert_ne!(after.handoff_consent_key, before.handoff_consent_key);
    assert_eq!(
        after.handoff_consent_key_version,
        before.handoff_consent_key_version + 1
    );
    assert_eq!(
        (after.tunnel_token, after.token_version),
        (before.tunnel_token, before.token_version)
    );
    assert!(w.requests().is_empty());
}

#[test]
fn rotate_token_keeps_the_consent_key() {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    let before = pair_sample(&paths, SAMPLE_ORG);
    let w = worker(|_| {
        MockResponse::json(
            200,
            serde_json::json!({
                "tunnel": {"id": crate::cloud::test_support::SAMPLE_TUNNEL_ID, "token": "t2", "token_version": 2},
                "rotated": true
            }),
        )
    });
    let r = run(root.path(), &w, false, "", &["rotate", "--yes"]);
    assert_eq!(r.code, 0, "{}", r.out);
    assert!(r.out.contains("was rotated"));
    let after = credentials::read(&paths).unwrap().unwrap();
    assert_eq!(after.token_version, 2);
    assert_eq!(after.handoff_consent_key, before.handoff_consent_key);
    assert_eq!(w.requests()[0].json()["reason"], "user");
}

#[test]
fn status_reports_exit_codes_and_json_without_secrets() {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    let w = worker(|_| MockResponse::error(410, "machine_revoked", "gone"));
    assert_eq!(run(root.path(), &w, false, "", &["status"]).code, 4);
    let creds = pair_sample(&paths, SAMPLE_ORG);
    let r = run(
        root.path(),
        &w,
        false,
        "",
        &["status", "--offline", "--json"],
    );
    assert_eq!(r.code, 3);
    let v: serde_json::Value = serde_json::from_str(&r.out).unwrap();
    assert_eq!(v["paired"], true);
    assert_eq!(v["hostname"], creds.hostname.as_str());
    assert!(v["remote"].is_null());
    assert!(!r.out.contains(&creds.tunnel_token) && !r.out.contains(&creds.machine_key_pkcs8));
    let r = run(root.path(), &w, false, "", &["status"]);
    assert_eq!(r.code, 5);
    assert!(r.out.contains("revoked"));
}

#[test]
fn login_prints_the_fingerprint_and_url_and_times_out() {
    let root = tempfile::tempdir().unwrap();
    let w = worker(|req| match req.path.as_str() {
        "/v1/meta" => MockResponse::json(
            200,
            serde_json::json!({
                "service": "yaran-cloud", "protocol": {"min": 1, "max": 1}, "setup": "closed",
                "org": {"name": "Example Org", "url": SAMPLE_ORG},
                "access": {"team_domain": "team.cloudflareaccess.com"}, "worker": {"version": "1.0.0"},
                "capabilities": [], "push": {"enabled": false, "vapid_public_key": null}
            }),
        ),
        _ => MockResponse::error(404, "not_found", "nope"),
    });
    let mut deps_args = vec!["login", "cloud.example.com", "--name", "box"];
    // A 1-second login timeout keeps the test fast; the browser "fails" to open.
    let paths = CloudPaths::from_root(root.path());
    let deps = CloudDeps {
        paths,
        config: CloudConfig {
            login_timeout_seconds: 1,
            ..CloudConfig::default()
        },
        server_port: 3890,
        api: test_api_factory(w.base_url()),
        is_tty: false,
        open_browser: Box::new(|_| Err("headless".into())),
        pickup_wait: Duration::ZERO,
    };
    let args: Vec<String> = deps_args.drain(..).map(String::from).collect();
    let mut out = Vec::new();
    let code = run_with(
        &args,
        deps,
        Box::new(std::io::Cursor::new(String::new())),
        &mut out,
    );
    let out = String::from_utf8(out).unwrap();
    assert_eq!(code, 1);
    assert!(out.contains("/v1/pair/authorize?"), "{out}");
    assert!(out.contains("yaran could not open a browser here"));
    assert!(out.contains("timed out"));
    let fp = out
        .lines()
        .find_map(|l| l.strip_prefix("Machine key fingerprint: "))
        .expect("fingerprint line");
    assert!(crate::cloud::protocol::rules::is_fingerprint(fp), "{fp}");
    let r = run(
        root.path(),
        &w,
        false,
        "",
        &["login", "--name", "Bad Name", "cloud.example.com"],
    );
    assert_eq!(r.code, 1);
    assert!(r.out.contains("--name bad-name"));
}

#[test]
fn pair_phone_prints_the_qr_for_the_paired_org() {
    let root = tempfile::tempdir().unwrap();
    let r = run(root.path(), &quiet(), false, "", &["pair-phone"]);
    assert_eq!(r.code, 2);
    let r = run(
        root.path(),
        &quiet(),
        false,
        "",
        &["pair-phone", "--org", "cloud.example.com"],
    );
    assert_eq!(r.code, 0);
    assert!(
        r.out
            .contains("yaranapp://add-org?u=https%3A%2F%2Fcloud.example.com")
    );
    assert!(r.out.contains('█'));
}
