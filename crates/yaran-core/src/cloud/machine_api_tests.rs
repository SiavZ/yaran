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

#[test]
fn no_secret_reaches_a_log_line() {
    use tracing_subscriber::layer::SubscriberExt;
    #[derive(Clone, Default)]
    struct Capture(std::sync::Arc<std::sync::Mutex<String>>);
    struct Visitor<'a>(&'a mut String);
    impl tracing::field::Visit for Visitor<'_> {
        fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
            self.0.push_str(&format!(" {}={:?}", field.name(), value));
        }
    }
    impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Capture {
        fn on_event(
            &self,
            event: &tracing::Event<'_>,
            _: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let mut line = String::new();
            event.record(&mut Visitor(&mut line));
            let mut all = self.0.lock().unwrap();
            all.push_str(&line);
            all.push('\n');
        }
    }
    let capture = Capture::default();
    let subscriber = tracing_subscriber::registry().with(capture.clone());
    let (_root, paths, _w, api) = setup(|req| match req.path.as_str() {
        "/v1/machine/rotate" => MockResponse::json(
            200,
            serde_json::json!({
                "tunnel": {"id": crate::cloud::test_support::SAMPLE_TUNNEL_ID, "token": "fresh-secret-token", "token_version": 2},
                "rotated": true
            }),
        ),
        _ => MockResponse::error(401, "signature_invalid", "bad signature"),
    });
    let creds = pair_sample(&paths, SAMPLE_ORG);
    tracing::subscriber::with_default(subscriber, || {
        api.rotate(RotateReason::User).unwrap();
        let _ = api.config();
        let _ = credentials::stamp_revoked(&paths);
    });
    let logged = capture.0.lock().unwrap().clone();
    assert!(logged.contains("/v1/machine/rotate"), "{logged}");
    for secret in [
        "fresh-secret-token",
        creds.tunnel_token.as_str(),
        creds.machine_key_pkcs8.as_str(),
        creds.handoff_consent_key.as_str(),
    ] {
        assert!(!logged.contains(secret), "secret in log: {logged}");
    }
}
