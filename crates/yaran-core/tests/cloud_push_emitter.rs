//! The phone-notification emitter against a mock Worker: signed delivery, retries with the
//! same ids, acknowledgement, pause and resume, `detail = minimal`, revocation, clock skew,
//! offline expiry and recovery, unpaired silence, and a hung Worker that never stalls `offer`.
//!
//! - Integration test; the Worker is `support/mock_worker.rs` on loopback.
//!
//! <module-headers:begin>
//! <module-headers:end>

#[path = "support/mock_worker.rs"]
mod mock_worker;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use mock_worker::{Answer, MACHINE_ID, MockWorker, machine_key};
use serde_json::json;
use yaran_core::cloud::protocol::machine::{AttentionEvent, AttentionKind, Event, RowStateToken};
use yaran_core::cloud::push_config::PushSettings;
use yaran_core::cloud::push_emitter::{LinkFactory, PushEmitter};
use yaran_core::cloud::push_link::{HttpMachineLink, LinkCredentials};
use yaran_core::cloud::push_queue::{event_ts, new_event_id};
use yaran_core::statusline::StatusTone;
use yaran_core::wire::status_keys::CLOUD_PUSH;
use yaran_core::worker::WorkerEvent;

struct Rig {
    worker: MockWorker,
    emitter: PushEmitter,
    statuses: Receiver<WorkerEvent>,
    paired: Arc<AtomicBool>,
    revoked: Arc<AtomicUsize>,
    org_url: Arc<Mutex<String>>,
}

fn settings(ttl: Duration) -> PushSettings {
    PushSettings {
        enabled: true,
        coalesce: Duration::ZERO,
        offline_ttl: ttl,
    }
}

fn rig_with(ttl: Duration) -> Rig {
    let worker = MockWorker::start();
    let paired = Arc::new(AtomicBool::new(true));
    let revoked = Arc::new(AtomicUsize::new(0));
    let org_url = Arc::new(Mutex::new(worker.base.clone()));
    let key = Arc::new(machine_key().0);
    let factory: LinkFactory = {
        let (paired, revoked, org_url) = (paired.clone(), revoked.clone(), org_url.clone());
        Arc::new(move || {
            let (paired, revoked, org_url, key) = (
                paired.clone(),
                revoked.clone(),
                org_url.clone(),
                key.clone(),
            );
            Box::new(HttpMachineLink::new(
                Box::new(move || {
                    paired.load(Ordering::SeqCst).then(|| LinkCredentials {
                        org_url: org_url.lock().unwrap().clone(),
                        org_name: "acme".into(),
                        machine_id: MACHINE_ID.into(),
                        key: key.clone(),
                    })
                }),
                Box::new(move || {
                    revoked.fetch_add(1, Ordering::SeqCst);
                }),
            ))
        })
    };
    let (tx, statuses) = mpsc::channel();
    let emitter = PushEmitter::with_link(settings(ttl), Some(tx), factory);
    Rig {
        worker,
        emitter,
        statuses,
        paired,
        revoked,
        org_url,
    }
}

fn rig() -> Rig {
    rig_with(Duration::from_secs(600))
}

fn event(agent: &str, kind: AttentionKind) -> Event {
    Event::Attention(AttentionEvent {
        id: new_event_id(),
        kind,
        ts: event_ts(),
        agent_id: agent.into(),
        tab_id: None,
        state: match kind {
            AttentionKind::AttentionRaised => RowStateToken::NeedsAttention,
            AttentionKind::AttentionCleared => RowStateToken::Idle,
        },
        project: Some("yaran".into()),
        label: Some("fix the flaky test".into()),
    })
}

const RAISE: AttentionKind = AttentionKind::AttentionRaised;
const CLEAR: AttentionKind = AttentionKind::AttentionCleared;

fn ids(seen: &mock_worker::Seen) -> Vec<String> {
    seen.body["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap().to_string())
        .collect()
}

fn next_status(rig: &Rig) -> (StatusTone, String) {
    loop {
        match rig
            .statuses
            .recv_timeout(Duration::from_secs(10))
            .expect("a status")
        {
            WorkerEvent::PollerStatus(s) => {
                assert_eq!(s.key.as_deref(), Some(CLOUD_PUSH));
                return (s.tone, s.message);
            }
            _ => continue,
        }
    }
}

fn quiet(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[test]
fn a_raised_edge_is_one_signed_post_and_the_config_is_fetched_signed() {
    let mut rig = rig();
    rig.emitter.offer(event("a1", RAISE));
    let posts = rig.worker.wait_for_posts(1);
    quiet(200);
    assert_eq!(rig.worker.posts().len(), 1, "exactly one POST");
    assert_eq!(posts[0].path, "/v1/machine/events");
    assert!(
        posts[0].verified,
        "02 signature verifies with the machine key"
    );
    assert_eq!(posts[0].body["events"][0]["state"], "needs_attention");
    assert_eq!(posts[0].body["events"][0]["label"], "fix the flaky test");
    let gets = rig
        .worker
        .seen
        .lock()
        .unwrap()
        .iter()
        .filter(|s| s.method == "GET")
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(gets.len(), 1);
    assert!(gets[0].verified && gets[0].path == "/v1/machine/config");
}

#[test]
fn two_503s_then_202_retry_with_the_same_ids_and_deliver_once() {
    let mut rig = rig();
    rig.worker.script([
        Answer::Error(503, "unavailable", Some(0), None),
        Answer::Error(503, "unavailable", Some(0), None),
    ]);
    rig.emitter.offer(event("a1", RAISE));
    let posts = rig.worker.wait_for_posts(3);
    quiet(200);
    assert_eq!(rig.worker.posts().len(), 3);
    assert_eq!(ids(&posts[0]), ids(&posts[1]));
    assert_eq!(ids(&posts[1]), ids(&posts[2]));
    assert!(
        posts.iter().all(|p| p.verified),
        "every attempt is re-signed"
    );
}

#[test]
fn ids_in_duplicates_count_as_acknowledged() {
    let mut rig = rig();
    rig.worker.script([Answer::AcceptAsDuplicates]);
    rig.emitter.offer(event("a1", RAISE));
    rig.worker.wait_for_posts(1);
    // The clear goes out only because the raise counted as landed.
    rig.emitter.offer(event("a1", CLEAR));
    let posts = rig.worker.wait_for_posts(2);
    assert_eq!(posts[1].body["events"][0]["kind"], "attention_cleared");
}

#[test]
fn rate_limited_waits_for_retry_after() {
    let mut rig = rig();
    rig.worker
        .script([Answer::Error(429, "rate_limited", Some(1), None)]);
    rig.emitter.offer(event("a1", RAISE));
    let posts = rig.worker.wait_for_posts(2);
    assert!(posts[1].at - posts[0].at >= Duration::from_millis(900));
    assert_eq!(ids(&posts[0]), ids(&posts[1]));
}

#[test]
fn payload_too_large_drops_the_batch_without_retrying() {
    let mut rig = rig();
    rig.worker
        .script([Answer::Error(413, "payload_too_large", None, None)]);
    rig.emitter.offer(event("a1", RAISE));
    rig.worker.wait_for_posts(1);
    quiet(500);
    assert_eq!(rig.worker.posts().len(), 1);
}

#[test]
fn push_enabled_false_pauses_until_the_config_turns_it_back_on() {
    let mut rig = rig();
    rig.worker.script([Answer::AcceptPushOff]);
    rig.emitter.offer(event("a1", RAISE));
    rig.worker.wait_for_posts(1);
    rig.emitter.offer(event("a2", RAISE));
    quiet(300);
    assert_eq!(rig.worker.posts().len(), 1, "paused: nothing sent");
    // The org turns push back on; a retune (config reload) rechecks at once.
    rig.worker.config.lock().unwrap()["push"]["enabled"] = json!(true);
    rig.emitter.retune(settings(Duration::from_secs(600)));
    quiet(200);
    rig.emitter.offer(event("a3", RAISE));
    let posts = rig.worker.wait_for_posts(2);
    assert_eq!(
        posts[1].body["events"][0]["agent_id"], "a3",
        "a2 was discarded while paused"
    );
    assert!(rig.statuses.try_recv().is_err(), "pausing raises no status");
}

#[test]
fn minimal_detail_sends_no_label_or_project() {
    let mut rig = rig();
    rig.worker.config.lock().unwrap()["push"]["detail"] = json!("minimal");
    rig.emitter.offer(event("a1", RAISE));
    let posts = rig.worker.wait_for_posts(1);
    let sent = &posts[0].body["events"][0];
    assert!(
        sent.get("label").is_none() && sent.get("project").is_none(),
        "{sent}"
    );
}

#[test]
fn machine_revoked_stops_the_emitter_and_reports_on_both_seams() {
    let mut rig = rig();
    rig.worker
        .script([Answer::Error(410, "machine_revoked", None, None)]);
    rig.emitter.offer(event("a1", RAISE));
    let (tone, message) = next_status(&rig);
    assert_eq!(tone, StatusTone::Warning);
    assert!(
        message.contains("no longer paired") && message.contains("acme"),
        "{message}"
    );
    assert_eq!(
        rig.revoked.load(Ordering::SeqCst),
        1,
        "verdict handed to 09/10's seam"
    );
    rig.emitter.offer(event("a2", RAISE));
    quiet(300);
    assert_eq!(rig.worker.posts().len(), 1, "stopped for good");
}

#[test]
fn signature_expired_names_the_clock_offset() {
    let mut rig = rig();
    let ahead = (chrono::Utc::now() + chrono::Duration::seconds(600))
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    rig.worker.script([Answer::Error(
        401,
        "signature_expired",
        None,
        Some(json!({"server_time": ahead})),
    )]);
    rig.emitter.offer(event("a1", RAISE));
    let (tone, message) = next_status(&rig);
    assert_eq!(tone, StatusTone::Warning);
    assert!(
        message.contains("seconds behind") && message.contains("clock"),
        "{message}"
    );
}

#[test]
fn offline_beyond_the_ttl_warns_then_recovery_posts_an_info() {
    let mut rig = rig_with(Duration::from_secs(1));
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    *rig.org_url.lock().unwrap() = format!("http://{}", dead.local_addr().unwrap());
    drop(dead);
    rig.emitter.offer(event("a1", RAISE));
    let (tone, message) = next_status(&rig);
    assert_eq!(tone, StatusTone::Warning);
    assert!(
        message.contains("1 phone notification") && message.contains("could not be reached"),
        "{message}"
    );
    *rig.org_url.lock().unwrap() = rig.worker.base.clone();
    let started = Instant::now();
    while rig.worker.posts().is_empty() {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "never recovered"
        );
        rig.emitter.offer(event("a2", RAISE));
        quiet(300);
    }
    let (tone, message) = next_status(&rig);
    assert_eq!(tone, StatusTone::Info);
    assert!(message.contains("again"), "{message}");
}

#[test]
fn an_unpaired_machine_makes_no_request() {
    let mut rig = rig();
    rig.paired.store(false, Ordering::SeqCst);
    rig.emitter.offer(event("a1", RAISE));
    quiet(300);
    assert!(rig.worker.seen.lock().unwrap().is_empty());
}

#[test]
fn a_hung_worker_never_stalls_offer() {
    let mut rig = rig();
    rig.worker.script([Answer::Hang]);
    rig.emitter.offer(event("a1", RAISE));
    rig.worker.wait_for_posts(1);
    // The thread is stuck in the request; the channel fills and offers count drops.
    let started = Instant::now();
    for i in 0..600 {
        rig.emitter.offer(event(&format!("b{i}"), RAISE));
    }
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "{:?}",
        started.elapsed()
    );
    assert!(rig.emitter.dropped() > 0);
    assert_eq!(rig.worker.config_gets(), 1);
}
