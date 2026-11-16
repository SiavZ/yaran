//! Integration: the full browser login against a mock Worker and a fake browser.
//!
//! The fake `LoginIo` plays the browser: it reads the authorize URL and either GETs the
//! loopback callback, or (a remote browser) hands the landing address to the paste
//! channel. Covers success, paste, a failed browser open (19 H1), already-paired,
//! protocol mismatch, claim refusal, timeout, cancel (before and after the claim), a
//! pairing changed during the claim, and the D24 consent key.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! tests/cloud_login.rs
//! ├── after_claim
//! ├── yaran-core::cloud::credentials
//! ├── yaran-core::cloud::login
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::pkce
//! ├── yaran-core::cloud::protocol::rules
//! └── yaran-core::cloud::test_support
//! External: serde_json, std, tempfile, url
//!
//! Used by: entry point (cargo test -p yaran-core --test <name> (integration tests))
//! tests/cloud_login.rs
//! └── after_claim
//! ```
//! <module-headers:end>

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

use yaran_core::cloud::credentials;
use yaran_core::cloud::login::{LoginIo, LoginParams, LoginStep, run_login};
use yaran_core::cloud::machine_api::test_api_factory;
use yaran_core::cloud::outcome::CloudActionOutcome;
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::pkce::s256_challenge;
use yaran_core::cloud::protocol::rules::b64url_decode;
use yaran_core::cloud::test_support::{
    MockResponse, MockWorker, RecordedRequest, SAMPLE_HOSTNAME, SAMPLE_MACHINE_ID, SAMPLE_ORG,
    pair_sample, sample_claim, sample_credentials,
};

#[derive(Clone, Copy, PartialEq)]
enum Browser {
    Loopback,
    Paste,
    OpenFailsThenLoopback,
    Never,
    Deny,
}

struct FakeIo {
    browser: Browser,
    tx: Sender<String>,
    rx: Option<Receiver<String>>,
    authorize: Option<String>,
    fingerprint: String,
    steps: Vec<LoginStep>,
    cancel_after_polls: Option<usize>,
    /// Set from elsewhere (the mock Worker) to cancel at any moment.
    cancel: Arc<AtomicBool>,
    /// A cancel that wins the race at the commit point, just before the claim.
    refuse_commit: bool,
}

impl FakeIo {
    fn new(browser: Browser) -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            browser,
            tx,
            rx: Some(rx),
            authorize: None,
            fingerprint: String::new(),
            steps: vec![],
            cancel_after_polls: None,
            cancel: Arc::default(),
            refuse_commit: false,
        }
    }
}

fn query_of(url: &str) -> HashMap<String, String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .into_owned()
        .collect()
}

fn hit_callback(callback: String, query: String) {
    std::thread::spawn(move || {
        let addr = callback
            .trim_start_matches("http://")
            .trim_end_matches("/callback")
            .to_string();
        let mut s = std::net::TcpStream::connect(addr).unwrap();
        write!(
            s,
            "GET /callback?{query} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
    });
}

const CODE: &str = "pppppppppppppppppppppppppppppppppppppppppp1";

impl LoginIo for FakeIo {
    fn open_browser(&mut self, url: &str) -> Result<(), String> {
        let q = query_of(url);
        let ok = format!("code={CODE}&state={}", q["state"]);
        match self.browser {
            Browser::Loopback => hit_callback(q["callback"].clone(), ok),
            Browser::Deny => hit_callback(
                q["callback"].clone(),
                format!("error=pair_denied&state={}", q["state"]),
            ),
            Browser::Paste => {
                self.tx
                    .send("http://127.0.0.1:1/callback?code=x&state=y".into())
                    .unwrap();
                self.tx.send(format!("{}?{ok}", q["callback"])).unwrap();
            }
            Browser::OpenFailsThenLoopback => {
                hit_callback(q["callback"].clone(), ok);
                return Err("no display".into());
            }
            Browser::Never => {}
        }
        Ok(())
    }
    fn show_authorize(&mut self, url: &str, fingerprint: &str, _org: &str, _name: &str) {
        self.authorize = Some(url.to_string());
        self.fingerprint = fingerprint.to_string();
    }
    fn pasted_callback(&mut self) -> Receiver<String> {
        self.rx.take().unwrap()
    }
    fn cancelled(&mut self) -> bool {
        if self.cancel.load(Ordering::SeqCst) {
            return true;
        }
        match &mut self.cancel_after_polls {
            Some(0) => true,
            Some(n) => {
                *n -= 1;
                false
            }
            None => false,
        }
    }
    fn commit(&mut self) -> bool {
        !self.refuse_commit && !self.cancelled()
    }
    fn progress(&mut self, step: LoginStep) {
        self.steps.push(step);
    }
}

fn meta(min: i64) -> serde_json::Value {
    serde_json::json!({
        "service": "yaran-cloud", "protocol": {"min": min, "max": min.max(1)}, "setup": "closed",
        "org": {"name": "Example Org", "url": SAMPLE_ORG},
        "access": {"team_domain": "team.cloudflareaccess.com"}, "worker": {"version": "1.0.0"},
        "capabilities": [], "push": {"enabled": false, "vapid_public_key": null}
    })
}

fn worker(min: i64, claim_ok: bool) -> MockWorker {
    MockWorker::start(move |req| match req.path.as_str() {
        "/v1/meta" => MockResponse::json(200, meta(min)),
        "/v1/machine/claim" if claim_ok => {
            MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
        }
        "/v1/machine/claim" => {
            MockResponse::error(400, "pkce_mismatch", "The verifier does not match.")
        }
        _ => MockResponse::error(404, "not_found", "nope"),
    })
}

fn login(
    w: &MockWorker,
    paths: &CloudPaths,
    io: &mut FakeIo,
    timeout: Duration,
) -> CloudActionOutcome {
    run_login(
        LoginParams {
            org_url: "cloud.example.com".into(),
            machine_name: Some("laptop".into()),
            origin_port: 4123,
            timeout,
            paths: paths.clone(),
            api: test_api_factory(w.base_url()),
        },
        io,
    )
}

fn setup() -> (tempfile::TempDir, CloudPaths) {
    let root = tempfile::tempdir().unwrap();
    let paths = CloudPaths::from_root(root.path());
    (root, paths)
}

#[test]
fn a_full_login_pairs_and_stores_the_claim() {
    let (_root, paths) = setup();
    let w = worker(1, true);
    let mut io = FakeIo::new(Browser::Loopback);
    let out = login(&w, &paths, &mut io, Duration::from_secs(10));
    assert_eq!(
        out,
        CloudActionOutcome::Paired {
            hostname: SAMPLE_HOSTNAME.into(),
            org_name: "Example Org".into()
        }
    );

    let authorize = query_of(io.authorize.as_ref().unwrap());
    assert_eq!(authorize["origin_port"], "4123");
    assert_eq!(authorize["machine_name"], "laptop");
    let claim_req = w
        .requests()
        .into_iter()
        .find(|r| r.path == "/v1/machine/claim")
        .unwrap();
    let body = claim_req.json();
    assert_eq!(body["origin_port"], 4123);
    assert_eq!(body["code"], CODE);
    assert_eq!(
        s256_challenge(body["code_verifier"].as_str().unwrap()),
        authorize["code_challenge"]
    );
    let pubkey = b64url_decode(&authorize["machine_pubkey"]).unwrap();
    assert!(claim_req.signature_verifies(&pubkey));

    let creds = credentials::read(&paths).unwrap().unwrap();
    assert_eq!(creds.owner_email, "sam@example.com");
    assert_eq!(creds.origin_port, 3890);
    assert_eq!(creds.token_version, 1);
    let key: [u8; 32] = pubkey.try_into().unwrap();
    assert_eq!(
        io.fingerprint,
        yaran_core::cloud::protocol::fingerprint::machine_key_fingerprint(&key)
    );
    let consent = credentials::read_handoff_consent_key(&paths)
        .unwrap()
        .unwrap();
    assert_eq!(consent.version, 1);

    // A same-org re-pair mints a different consent key, one version up.
    let mut io = FakeIo::new(Browser::Loopback);
    assert!(matches!(
        login(&w, &paths, &mut io, Duration::from_secs(10)),
        CloudActionOutcome::Paired { .. }
    ));
    let again = credentials::read_handoff_consent_key(&paths)
        .unwrap()
        .unwrap();
    assert_eq!(again.version, 2);
    assert_ne!(again.key, consent.key);
}

#[test]
fn the_paste_path_works_when_the_browser_cannot_reach_the_listener() {
    let (_root, paths) = setup();
    let w = worker(1, true);
    let mut io = FakeIo::new(Browser::Paste);
    assert!(matches!(
        login(&w, &paths, &mut io, Duration::from_secs(10)),
        CloudActionOutcome::Paired { .. }
    ));
    assert!(
        io.steps
            .iter()
            .any(|s| matches!(s, LoginStep::PasteRejected { .. }))
    );
}

#[test]
fn a_failed_browser_open_still_shows_the_url_and_completes() {
    let (_root, paths) = setup();
    let w = worker(1, true);
    let mut io = FakeIo::new(Browser::OpenFailsThenLoopback);
    assert!(matches!(
        login(&w, &paths, &mut io, Duration::from_secs(10)),
        CloudActionOutcome::Paired { .. }
    ));
    let url = io.authorize.clone().unwrap();
    assert!(io.steps.contains(&LoginStep::BrowserUnavailable { url }));
}

#[test]
fn a_different_paired_org_is_refused_before_any_request() {
    let (_root, paths) = setup();
    pair_sample(&paths, "https://other.example.org");
    let w = worker(1, true);
    let out = login(
        &w,
        &paths,
        &mut FakeIo::new(Browser::Loopback),
        Duration::from_secs(5),
    );
    assert!(matches!(
        out,
        CloudActionOutcome::AlreadyPairedElsewhere { .. }
    ));
    assert!(out.report().message().contains("yaran cloud logout"));
    assert!(w.requests().is_empty());
}

#[test]
fn a_protocol_mismatch_stops_the_login() {
    let (_root, paths) = setup();
    let out = login(
        &worker(5, true),
        &paths,
        &mut FakeIo::new(Browser::Loopback),
        Duration::from_secs(5),
    );
    assert!(matches!(
        out,
        CloudActionOutcome::ProtocolUnsupported { min: 5, .. }
    ));
}

#[test]
fn a_refused_claim_leaves_the_old_credentials_and_consent_key() {
    let (_root, paths) = setup();
    assert!(matches!(
        login(&worker(1, false), &paths, &mut FakeIo::new(Browser::Loopback), Duration::from_secs(10)),
        CloudActionOutcome::ClaimRefused { ref code, .. } if code == "pkce_mismatch"
    ));
    assert_eq!(credentials::read(&paths).unwrap(), None);
    let before = pair_sample(&paths, SAMPLE_ORG);
    let out = login(
        &worker(1, false),
        &paths,
        &mut FakeIo::new(Browser::Loopback),
        Duration::from_secs(10),
    );
    assert!(matches!(out, CloudActionOutcome::ClaimRefused { .. }));
    assert_eq!(credentials::read(&paths).unwrap(), Some(before));
    let denied = login(
        &worker(1, true),
        &paths,
        &mut FakeIo::new(Browser::Deny),
        Duration::from_secs(10),
    );
    assert!(
        matches!(denied, CloudActionOutcome::ClaimRefused { ref code, .. } if code == "pair_denied")
    );
    // The loopback page promises the terminal says why, so the code alone is not enough.
    let said = denied.report().message().to_string();
    assert!(said.contains("pressed Deny"), "{said}");
    assert!(said.contains("start the login again"), "{said}");
}

#[test]
fn timeout_and_cancel_end_the_wait() {
    let (_root, paths) = setup();
    let w = worker(1, true);
    let out = login(
        &w,
        &paths,
        &mut FakeIo::new(Browser::Never),
        Duration::from_millis(300),
    );
    assert_eq!(out, CloudActionOutcome::LoginTimedOut);
    let mut io = FakeIo::new(Browser::Never);
    io.cancel_after_polls = Some(2);
    assert_eq!(
        login(&w, &paths, &mut io, Duration::from_secs(30)),
        CloudActionOutcome::LoginCancelled
    );
    assert_eq!(credentials::read(&paths).unwrap(), None);
}

/// A Worker whose claim runs `during_claim` before answering, and which accepts W8.
fn claim_side_effect(during_claim: impl Fn() + Send + Sync + 'static) -> MockWorker {
    MockWorker::start(move |req| match req.path.as_str() {
        "/v1/meta" => MockResponse::json(200, meta(1)),
        "/v1/machine/claim" => {
            during_claim();
            MockResponse::json(200, serde_json::to_value(sample_claim(SAMPLE_ORG)).unwrap())
        }
        "/v1/machine/unpair" => MockResponse::json(
            202,
            serde_json::json!({"machine_id": SAMPLE_MACHINE_ID, "state": "tearing_down"}),
        ),
        _ => MockResponse::error(404, "not_found", "nope"),
    })
}

/// Cleanup was requested once, signed with the key the discarded claim used.
fn assert_claim_unpair_requested(w: &MockWorker, io: &FakeIo) {
    let unpair: Vec<RecordedRequest> = w
        .requests()
        .into_iter()
        .filter(|r| r.path == "/v1/machine/unpair")
        .collect();
    assert_eq!(
        unpair.len(),
        1,
        "cleanup of the discarded claim is requested once"
    );
    assert_eq!(
        unpair[0].header("Yaran-Machine-Id"),
        Some(SAMPLE_MACHINE_ID)
    );
    let pubkey = b64url_decode(&query_of(io.authorize.as_ref().unwrap())["machine_pubkey"]);
    assert!(unpair[0].signature_verifies(&pubkey.unwrap()));
}

/// This machine's current pairing, distinct from the one `sample_claim` answers with.
fn pair_previous(paths: &CloudPaths) -> credentials::Credentials {
    let mut previous = sample_credentials(SAMPLE_ORG);
    previous.machine_id = "3c1f6a52-7e0b-4d8e-a1f2-9b8c7d6e5f40".into();
    credentials::update(paths, |_| Ok(Some(previous.clone()))).unwrap();
    previous
}

#[test]
fn a_cancel_that_wins_before_the_claim_sends_nothing() {
    let (_root, paths) = setup();
    let previous = pair_previous(&paths);
    let w = claim_side_effect(|| {});
    let mut io = FakeIo::new(Browser::Loopback);
    io.refuse_commit = true;
    let out = login(&w, &paths, &mut io, Duration::from_secs(10));
    assert_eq!(out, CloudActionOutcome::LoginCancelled);
    assert!(out.report().message().contains("nothing was changed"));
    assert_eq!(credentials::read(&paths).unwrap(), Some(previous));
    assert!(
        w.requests().iter().all(|r| r.path == "/v1/meta"),
        "no claim (which could tear a replaced machine down) and no unpair was sent"
    );
}

#[test]
fn a_cancel_after_a_replace_claim_is_sent_is_too_late_and_the_login_completes() {
    let (_root, paths) = setup();
    let previous = pair_previous(&paths);
    let mut io = FakeIo::new(Browser::Loopback);
    let cancel = io.cancel.clone();
    // The person chose Replace: the Worker tears the previous machine down at claim time,
    // and the cancel lands while that claim is in flight.
    let torn_down = Arc::new(AtomicBool::new(false));
    let tear = torn_down.clone();
    let w = claim_side_effect(move || {
        tear.store(true, Ordering::SeqCst);
        cancel.store(true, Ordering::SeqCst);
    });
    let out = login(&w, &paths, &mut io, Duration::from_secs(10));
    assert!(torn_down.load(Ordering::SeqCst));
    assert!(matches!(out, CloudActionOutcome::Paired { .. }), "{out:?}");
    let stored = credentials::read(&paths).unwrap().unwrap();
    assert_eq!(
        stored.machine_id, SAMPLE_MACHINE_ID,
        "the new pairing is installed"
    );
    assert_ne!(stored.machine_id, previous.machine_id);
    assert!(
        w.requests().iter().all(|r| r.path != "/v1/machine/unpair"),
        "the claim is kept, so the machine is not left with both pairings dead"
    );
}

#[path = "cloud_login/after_claim.rs"]
mod after_claim;
