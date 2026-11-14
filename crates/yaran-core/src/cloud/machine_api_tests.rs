//! Unit tests for `MachineApi`: transport rules, body cap, revocation, write-backs.
//!
//! <module-headers:begin>
//! <module-headers:end>

use super::*;
use crate::cloud::test_support::{MockResponse, MockWorker, SAMPLE_ORG, pair_sample};

fn setup(
    handler: impl Fn(&crate::cloud::test_support::RecordedRequest) -> MockResponse
    + Send
    + Sync
    + 'static,
) -> (tempfile::TempDir, CloudPaths, MockWorker, MachineApi) {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    let worker = MockWorker::start(handler);
    let api = MachineApi::new(SAMPLE_ORG, &paths, Duration::from_secs(5))
        .unwrap()
        .with_test_transport(&worker.base_url());
    (root, paths, worker, api)
}

#[test]
fn plain_http_is_refused_without_the_test_transport() {
    let paths = CloudPaths::from_root(std::path::Path::new("/nonexistent"));
    assert!(matches!(
        MachineApi::new("http://127.0.0.1:9", &paths, Duration::from_secs(1)),
        Err(MachineApiError::Malformed(_))
    ));
}

#[test]
fn the_body_cap_is_enforced() {
    let (_root, paths, _w, api) = setup(|_| MockResponse {
        status: 200,
        headers: vec![],
        body: format!("\"{}\"", "x".repeat(70 * 1024)),
    });
    pair_sample(&paths, SAMPLE_ORG);
    assert!(matches!(api.config(), Err(MachineApiError::Malformed(_))));
}

#[test]
fn a_410_raises_the_signal_and_stamps_the_credentials() {
    let (_root, paths, worker, api) =
        setup(|_| MockResponse::error(410, "machine_revoked", "This machine was revoked."));
    let creds = pair_sample(&paths, SAMPLE_ORG);
    let rx = RevocationSignal::global().subscribe();
    assert_eq!(api.config(), Err(MachineApiError::Revoked));
    assert!(rx.try_recv().is_ok());
    assert!(credentials::read(&paths).unwrap().unwrap().is_revoked());
    let req = &worker.requests()[0];
    assert!(
        req.signature_verifies(&crate::cloud::test_support::public_key_of(
            &creds.machine_key_der().unwrap()
        ))
    );
    assert_eq!(
        req.header("Yaran-Machine-Id"),
        Some(creds.machine_id.as_str())
    );
}

#[test]
fn a_signed_call_without_credentials_is_not_paired() {
    let (_root, _paths, worker, api) = setup(|_| MockResponse::json(200, serde_json::json!({})));
    assert_eq!(api.config(), Err(MachineApiError::NotPaired));
    assert!(worker.requests().is_empty());
}

#[test]
fn an_unreachable_control_plane_is_a_network_error() {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    pair_sample(&paths, SAMPLE_ORG);
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let api = MachineApi::new(SAMPLE_ORG, &paths, Duration::from_secs(1))
        .unwrap()
        .with_test_transport(&format!("http://127.0.0.1:{port}"));
    assert!(matches!(api.config(), Err(MachineApiError::Network(_))));
}
