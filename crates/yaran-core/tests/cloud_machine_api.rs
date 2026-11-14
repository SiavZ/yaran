//! Integration: `MachineApi` against a loopback mock Worker that verifies every signature.
//!
//! Plays W1, W4, W5, W7 (`user` and `sync`), W8 (202 and 410) and W32 (`changed` true and
//! false) with success, revocation, clock-skew and malformed answers. No real control
//! plane is ever contacted.
//!
//! <module-headers:begin>
//! Uses:
//! tests/cloud_machine_api.rs
//! ├── yaran-core::cloud::credentials
//! ├── yaran-core::cloud::identity
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::protocol::machine
//! └── yaran-core::cloud::test_support
//! External: serde_json, std, tempfile
//!
//! Used by: entry point (cargo test -p yaran-core --test <name> (integration tests))
//! <module-headers:end>

use std::time::Duration;

use yaran_core::cloud::credentials;
use yaran_core::cloud::identity::MachineIdentity;
use yaran_core::cloud::machine_api::{MachineApi, MachineApiError, Unpaired};
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::protocol::machine::{ClaimRequest, RotateReason};
use yaran_core::cloud::test_support::{
    MockResponse, MockWorker, RecordedRequest, SAMPLE_ORG, SAMPLE_TUNNEL_ID, pair_sample,
    public_key_of, sample_claim,
};

fn api_for(
    handler: impl Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
) -> (tempfile::TempDir, CloudPaths, MockWorker, MachineApi) {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    let worker = MockWorker::start(handler);
    let api = MachineApi::new(SAMPLE_ORG, &paths, Duration::from_secs(5))
        .unwrap()
        .with_test_transport(&worker.base_url());
    (root, paths, worker, api)
}

fn meta_json() -> serde_json::Value {
    serde_json::json!({
        "service": "yaran-cloud",
        "protocol": {"min": 1, "max": 1},
        "setup": "closed",
        "org": {"name": "Example Org", "url": SAMPLE_ORG},
        "access": {"team_domain": "team.cloudflareaccess.com"},
        "worker": {"version": "1.0.0"},
        "capabilities": ["push"],
        "push": {"enabled": false, "vapid_public_key": null}
    })
}

fn config_json(token_version: i64) -> serde_json::Value {
    serde_json::json!({
        "machine_id": yaran_core::cloud::test_support::SAMPLE_MACHINE_ID,
        "hostname": yaran_core::cloud::test_support::SAMPLE_HOSTNAME,
        "url": "https://laptop-sam.machines.example.com",
        "origin_port": 3890,
        "access": {"team_domain": "team.cloudflareaccess.com", "aud": "a".repeat(64)},
        "tunnel": {"id": SAMPLE_TUNNEL_ID, "token_version": token_version},
        "owner_email": "sam@example.com",
        "push": {"enabled": true, "detail": "names"},
        "events": {"max_batch": 16, "min_interval_ms": 0},
        "server_time": "2026-11-14T12:00:00Z"
    })
}

#[test]
fn meta_negotiates_and_a_protocol_mismatch_is_typed() {
    let (_r, _p, _w, api) = api_for(|_| MockResponse::json(200, meta_json()));
    assert_eq!(api.meta().unwrap().org.unwrap().name, "Example Org");
    let mut newer = meta_json();
    newer["protocol"] = serde_json::json!({"min": 5, "max": 6});
    let (_r, _p, _w, api) = api_for(move |_| MockResponse::json(200, newer.clone()));
    assert!(matches!(
        api.meta(),
        Err(MachineApiError::ProtocolUnsupported { min: 5, max: 6, .. })
    ));
    let (_r, _p, _w, api) = api_for(|_| MockResponse::json(200, serde_json::json!({"service": 1})));
    assert!(matches!(api.meta(), Err(MachineApiError::Malformed(_))));
}

#[test]
fn the_claim_is_signed_without_a_machine_id() {
    let (_r, _p, worker, api) = api_for(|_| {
        MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
    });
    let id = MachineIdentity::generate().unwrap();
    let req = ClaimRequest {
        code: "c".repeat(43),
        code_verifier: "v".repeat(43),
        yaran_version: "0.1.0".into(),
        origin_port: 4000,
    };
    let claim = api.claim(&id, &req).unwrap();
    assert_eq!(claim.owner_email, "sam@example.com");
    let seen = &worker.requests()[0];
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/v1/machine/claim")
    );
    assert_eq!(seen.header("Yaran-Machine-Id"), None);
    assert!(seen.signature_verifies(&id.public_key()));
    assert_eq!(seen.json()["origin_port"], 4000);
}

#[test]
fn config_success_skew_and_revocation() {
    let (_r, paths, worker, api) = api_for(|_| MockResponse::json(200, config_json(1)));
    let creds = pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(api.config().unwrap().tunnel.token_version, 1);
    let seen = &worker.requests()[0];
    assert!(seen.signature_verifies(&public_key_of(&creds.machine_key_der().unwrap())));
    assert!(seen.body.is_empty());

    let (_r, paths, _w, api) = api_for(|_| {
        let mut r = MockResponse::error(401, "signature_expired", "clock");
        r.headers
            .push(("Date".into(), "Sat, 14 Nov 2026 12:00:00 GMT".into()));
        r
    });
    pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(
        api.config(),
        Err(MachineApiError::ClockSkew {
            server_time: Some("2026-11-14T12:00:00Z".into())
        })
    );

    let (_r, paths, _w, api) = api_for(|_| MockResponse::error(410, "machine_revoked", "gone"));
    pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(api.config(), Err(MachineApiError::Revoked));
    assert!(
        credentials::read(&paths)
            .unwrap()
            .unwrap()
            .revoked_at
            .is_some()
    );
}

#[test]
fn rotate_user_and_sync_rewrite_the_token_and_keep_the_consent_key() {
    for reason in [RotateReason::User, RotateReason::Sync] {
        let (_r, paths, worker, api) = api_for(|_| {
            MockResponse::json(
                200,
                serde_json::json!({
                    "tunnel": {"id": SAMPLE_TUNNEL_ID, "token": "tunnel-token-2", "token_version": 2},
                    "rotated": true
                }),
            )
        });
        let before = pair_sample(&paths, SAMPLE_ORG);
        api.rotate(reason).unwrap();
        let after = credentials::read(&paths).unwrap().unwrap();
        assert_eq!(
            (after.tunnel_token.as_str(), after.token_version),
            ("tunnel-token-2", 2)
        );
        assert_eq!(after.handoff_consent_key, before.handoff_consent_key);
        assert_eq!(
            after.handoff_consent_key_version,
            before.handoff_consent_key_version
        );
        let body = worker.requests()[0].json();
        assert_eq!(body["known_token_version"], 1);
        assert_eq!(
            body["reason"],
            if reason == RotateReason::User {
                "user"
            } else {
                "sync"
            }
        );
    }
}

#[test]
fn unpair_counts_202_and_410_as_done() {
    let (_r, paths, worker, api) = api_for(|_| {
        MockResponse::json(
            202,
            serde_json::json!({"machine_id": yaran_core::cloud::test_support::SAMPLE_MACHINE_ID, "state": "tearing_down"}),
        )
    });
    pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(api.unpair(), Ok(Unpaired::TeardownStarted));
    assert_eq!(worker.requests()[0].path, "/v1/machine/unpair");
    assert!(worker.requests()[0].body.is_empty());
    let (_r, paths, _w, api) = api_for(|_| MockResponse::error(410, "machine_revoked", "gone"));
    pair_sample(&paths, SAMPLE_ORG);
    assert_eq!(api.unpair(), Ok(Unpaired::AlreadyRevoked));
}

#[test]
fn set_origin_rewrites_the_stored_port() {
    for changed in [true, false] {
        let (_r, paths, worker, api) = api_for(move |_| {
            MockResponse::json(
                202,
                serde_json::json!({"origin_port": 4000, "changed": changed}),
            )
        });
        let before = pair_sample(&paths, SAMPLE_ORG);
        let result = api.set_origin(4000).unwrap();
        assert_eq!(result.changed, changed);
        let after = credentials::read(&paths).unwrap().unwrap();
        assert_eq!(after.origin_port, 4000);
        assert_eq!(after.tunnel_token, before.tunnel_token);
        let seen = &worker.requests()[0];
        assert_eq!(
            (seen.method.as_str(), seen.path.as_str()),
            ("PUT", "/v1/machine/origin")
        );
        assert!(seen.signature_verifies(&public_key_of(&before.machine_key_der().unwrap())));
    }
}
