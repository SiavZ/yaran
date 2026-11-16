//! Unit tests for the emitter handle and its response classification; the HTTP paths are
//! covered against a mock Worker in `tests/cloud_push_emitter.rs`.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::push_emitter`).
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/push_emitter_tests.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::push_emitter
//! ├── cloud::push_link
//! ├── cloud::push_queue
//! └── cloud::push_runner
//! External: std
//!
//! Used by:
//! cloud/push_emitter_tests.rs
//! └── cloud::push_emitter
//! ```
//! <module-headers:end>

use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;

use super::*;
use crate::cloud::protocol::ErrorCode;
use crate::cloud::protocol::machine::{AttentionKind, MachineConfig};
use crate::cloud::protocol::machine::{EventBatch, EventBatchResult};
use crate::cloud::push_link::MachineApiError;
use crate::cloud::push_queue::tests::attention;
use crate::cloud::push_runner::{Verdict, classify};
use std::time::Instant;

#[derive(Default)]
struct Calls {
    configs: usize,
    batches: Vec<EventBatch>,
}

struct FakeLink {
    paired: bool,
    calls: Arc<Mutex<Calls>>,
}

impl MachineLink for FakeLink {
    fn org_name(&mut self) -> Option<String> {
        self.paired.then(|| "acme".to_string())
    }
    fn machine_config(&mut self) -> Result<MachineConfig, MachineApiError> {
        self.calls.lock().unwrap().configs += 1;
        Err(MachineApiError::Network("no config in this fake".into()))
    }
    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, MachineApiError> {
        self.calls.lock().unwrap().batches.push(batch.clone());
        Ok(EventBatchResult {
            accepted: batch
                .events
                .iter()
                .map(|e| match e {
                    Event::Attention(a) => a.id.clone(),
                    Event::Exit(x) => x.id.clone(),
                })
                .collect(),
            duplicates: Vec::new(),
            push_enabled: true,
        })
    }
    fn report_revoked(&mut self) {}
}

fn on() -> PushSettings {
    PushSettings {
        enabled: true,
        coalesce: Duration::ZERO,
        offline_ttl: Duration::from_secs(600),
    }
}

#[expect(
    clippy::fn_params_excessive_bools,
    reason = "paired is handed straight to the fake link's field of the same name"
)]
fn emitter(paired: bool) -> (PushEmitter, Arc<Mutex<Calls>>, Arc<AtomicUsize>) {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let built = Arc::new(AtomicUsize::new(0));
    let factory: LinkFactory = {
        let (calls, built) = (std::sync::Arc::clone(&calls), std::sync::Arc::clone(&built));
        Arc::new(move || {
            built.fetch_add(1, Ordering::SeqCst);
            Box::new(FakeLink {
                paired,
                calls: std::sync::Arc::clone(&calls),
            })
        })
    };
    (
        PushEmitter::with_link(PushSettings::off(), None, factory),
        calls,
        built,
    )
}

fn wait_for(cond: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn push_emitter_classifies_every_answer() {
    // Whether a refusal retries is the registry's answer for its code.
    let refused = |code: ErrorCode| MachineApiError::Refused {
        code: code.as_str().into(),
        message: "m".into(),
        retry_after: None,
    };
    assert_eq!(classify(Err(MachineApiError::Revoked)), Verdict::Revoked);
    assert_eq!(
        classify(Err(refused(ErrorCode::MachineUnknown))),
        Verdict::Revoked
    );
    assert!(matches!(
        classify(Err(refused(ErrorCode::RateLimited))),
        Verdict::Retry { .. }
    ));
    assert!(matches!(
        classify(Err(refused(ErrorCode::PayloadTooLarge))),
        Verdict::DropBatch { .. }
    ));
    assert!(matches!(
        classify(Err(refused(ErrorCode::ValidationFailed))),
        Verdict::DropBatch { .. }
    ));
    let server = |status| MachineApiError::Server {
        status,
        retry_after: Some(7),
    };
    assert_eq!(
        classify(Err(server(503))),
        Verdict::Retry {
            after: Some(Duration::from_secs(7)),
            error: "the control plane answered HTTP 503".into()
        }
    );
    assert!(matches!(
        classify(Err(server(422))),
        Verdict::DropBatch { .. }
    ));
    assert!(matches!(
        classify(Err(MachineApiError::Network("x".into()))),
        Verdict::Retry { after: None, .. }
    ));
    assert!(matches!(
        classify(Err(MachineApiError::Malformed("x".into()))),
        Verdict::DropBatch { .. }
    ));
    assert_eq!(
        classify(Err(MachineApiError::ClockSkew { server_time: None })),
        Verdict::ClockSkew { server_time: None }
    );
    let delivered = classify(Ok(EventBatchResult {
        accepted: vec!["a".into()],
        duplicates: vec!["b".into()],
        push_enabled: false,
    }));
    assert_eq!(
        delivered,
        Verdict::Delivered {
            acknowledged: ["a".to_string(), "b".to_string()].into(),
            push_enabled: false
        }
    );
}

#[test]
fn push_emitter_retune_is_idempotent() {
    let (mut e, _calls, built) = emitter(false);
    assert!(!e.is_on());
    e.retune(on());
    e.retune(on());
    assert!(e.is_on());
    assert_eq!(
        built.load(Ordering::SeqCst),
        1,
        "one thread for two retunes"
    );
    e.retune(PushSettings::off());
    e.retune(PushSettings::off());
    assert!(!e.is_on());
    e.retune(on());
    assert_eq!(built.load(Ordering::SeqCst), 2);
}

#[test]
fn push_emitter_unpaired_makes_no_request() {
    let (mut e, calls, _) = emitter(false);
    e.retune(on());
    e.offer(attention("a", AttentionKind::AttentionRaised));
    thread::sleep(Duration::from_millis(200));
    drop(e);
    let calls = calls.lock().unwrap();
    assert_eq!((calls.configs, calls.batches.len()), (0, 0));
}

#[test]
fn push_emitter_drop_flushes_idle_clears_within_the_bound() {
    let (mut e, calls, _) = emitter(true);
    e.retune(on());
    e.offer(attention("a", AttentionKind::AttentionRaised));
    wait_for(|| calls.lock().unwrap().batches.len() == 1);
    let started = Instant::now();
    drop(e);
    assert!(started.elapsed() < SHUTDOWN_JOIN + Duration::from_millis(500));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.batches.len(), 2, "one shutdown flush");
    match &calls.batches[1].events[..] {
        [Event::Attention(clear)] => {
            assert_eq!(clear.kind, AttentionKind::AttentionCleared);
            assert_eq!(
                clear.state,
                crate::cloud::protocol::machine::RowStateToken::Idle
            );
        }
        other => panic!("expected one clear, got {other:?}"),
    }
}

#[test]
fn push_emitter_off_drops_offers_without_a_thread() {
    let (mut e, calls, built) = emitter(true);
    e.offer(attention("a", AttentionKind::AttentionRaised));
    drop(e);
    assert_eq!(built.load(Ordering::SeqCst), 0);
    assert_eq!(
        calls.lock().unwrap().batches,
        Vec::<crate::cloud::protocol::machine::EventBatch>::new()
    );
}

/// A link whose pairing and answers a test changes while the thread runs.
#[derive(Clone, Default)]
struct Scripted {
    pairing: Arc<Mutex<Option<String>>>,
    pair_on_post: Arc<Mutex<Option<String>>>,
    revocations: Arc<AtomicUsize>,
    /// Answers for the next posts, in order; an empty script accepts.
    answers: Arc<Mutex<std::collections::VecDeque<MachineApiError>>>,
    batches: Arc<Mutex<Vec<EventBatch>>>,
    configs: Arc<AtomicUsize>,
    /// Every thread iteration reads the pairing once, so this counts wake-ups.
    pairing_reads: Arc<AtomicUsize>,
}

impl MachineLink for Scripted {
    fn org_name(&mut self) -> Option<String> {
        self.pairing.lock().unwrap().as_ref().map(|_| "acme".into())
    }
    fn pairing_key(&mut self) -> Option<String> {
        self.pairing_reads.fetch_add(1, Ordering::SeqCst);
        self.pairing.lock().unwrap().clone()
    }
    fn machine_config(&mut self) -> Result<MachineConfig, MachineApiError> {
        self.configs.fetch_add(1, Ordering::SeqCst);
        Err(MachineApiError::Network("no config in this fake".into()))
    }
    fn post_events(&mut self, batch: &EventBatch) -> Result<EventBatchResult, MachineApiError> {
        self.batches.lock().unwrap().push(batch.clone());
        if let Some(pairing) = self.pair_on_post.lock().unwrap().take() {
            *self.pairing.lock().unwrap() = Some(pairing);
        }
        if let Some(err) = self.answers.lock().unwrap().pop_front() {
            return Err(err);
        }
        let ids = batch.events.iter().map(|e| match e {
            Event::Attention(a) => a.id.clone(),
            Event::Exit(x) => x.id.clone(),
        });
        Ok(EventBatchResult {
            accepted: ids.collect(),
            duplicates: Vec::new(),
            push_enabled: true,
        })
    }
    fn report_revoked(&mut self) {
        self.revocations.fetch_add(1, Ordering::SeqCst);
    }
}

fn scripted(link: &Scripted, coalesce: Duration) -> PushEmitter {
    let link = link.clone();
    let settings = PushSettings { coalesce, ..on() };
    PushEmitter::with_link(settings, None, Arc::new(move || Box::new(link.clone())))
}

fn agents(batch: &EventBatch) -> Vec<String> {
    batch
        .events
        .iter()
        .map(|e| match e {
            Event::Attention(a) => a.agent_id.clone(),
            Event::Exit(x) => x.agent_id.clone(),
        })
        .collect()
}

#[test]
fn push_emitter_sleeps_through_coalescing_and_backoff() {
    let link = Scripted::default();
    *link.pairing.lock().unwrap() = Some("machine-a".into());
    link.answers
        .lock()
        .unwrap()
        .push_back(MachineApiError::Server {
            status: 503,
            retry_after: Some(10),
        });
    let mut e = scripted(&link, Duration::from_millis(600));
    e.offer(attention("a", AttentionKind::AttentionRaised));
    // Inside the coalescing window: the earlier send gates must not wake it up.
    let reads = link.pairing_reads.load(Ordering::SeqCst);
    thread::sleep(Duration::from_millis(300));
    let woke = link.pairing_reads.load(Ordering::SeqCst) - reads;
    assert!(woke <= 3, "spun {woke} times while coalescing");
    wait_for(|| link.batches.lock().unwrap().len() == 1);
    // Inside a ten-second Retry-After: the entry is due, but the backoff is not over.
    let reads = link.pairing_reads.load(Ordering::SeqCst);
    thread::sleep(Duration::from_millis(400));
    let woke = link.pairing_reads.load(Ordering::SeqCst) - reads;
    assert!(woke <= 3, "spun {woke} times during backoff");
    assert_eq!(link.batches.lock().unwrap().len(), 1);
    e.retune(PushSettings::off());
}

#[test]
fn wake_in_waits_for_every_send_gate() {
    use crate::cloud::push_runner::wake_in;
    let now = Instant::now();
    let ms = Duration::from_millis;
    // Coalescing: the entry is due later, the minimum interval already passed.
    assert_eq!(
        wake_in(
            now,
            Some(now + ms(400)),
            None,
            now.checked_sub(ms(5)).unwrap()
        ),
        ms(400)
    );
    // Backoff: due already, retry later.
    assert_eq!(wake_in(now, Some(now), Some(now + ms(700)), now), ms(700));
    // Minimum interval: due already, next send later.
    assert_eq!(
        wake_in(
            now,
            Some(now.checked_sub(ms(1)).unwrap()),
            None,
            now + ms(250)
        ),
        ms(250)
    );
    // Everything open: send now; long gates are capped at the expiry check.
    assert_eq!(
        wake_in(now, Some(now), Some(now.checked_sub(ms(1)).unwrap()), now),
        Duration::ZERO
    );
    assert_eq!(
        wake_in(now, Some(now), Some(now + ms(60_000)), now),
        Duration::from_secs(1)
    );
    assert_eq!(wake_in(now, None, None, now), Duration::from_secs(1));
}

#[test]
fn push_emitter_starts_over_when_the_machine_is_paired_again() {
    let link = Scripted::default();
    *link.pairing.lock().unwrap() = Some("machine-a".into());
    let mut e = scripted(&link, Duration::ZERO);
    let posts = || link.batches.lock().unwrap().len();
    e.offer(attention("x", AttentionKind::AttentionRaised));
    wait_for(|| posts() == 1);
    link.answers
        .lock()
        .unwrap()
        .push_back(MachineApiError::Revoked);
    e.offer(attention("y", AttentionKind::AttentionRaised));
    wait_for(|| posts() == 2);
    e.offer(attention("z", AttentionKind::AttentionRaised));
    thread::sleep(Duration::from_millis(200));
    assert_eq!(posts(), 2, "revoked: nothing more for the old pairing");
    let configs = link.configs.load(Ordering::SeqCst);

    *link.pairing.lock().unwrap() = Some("machine-b".into());
    // The new pairing never saw x raised, so its clear is no change; w is new.
    e.offer(attention("x", AttentionKind::AttentionCleared));
    e.offer(attention("w", AttentionKind::AttentionRaised));
    wait_for(|| posts() == 3);
    assert_eq!(agents(&link.batches.lock().unwrap()[2]), ["w"]);
    assert!(
        link.configs.load(Ordering::SeqCst) > configs,
        "the new pairing's org config is fetched, not the old one reused"
    );
    e.retune(PushSettings::off());
}

#[test]
fn push_emitter_ignores_a_revocation_for_the_previous_pairing() {
    let link = Scripted::default();
    *link.pairing.lock().unwrap() = Some("machine-a".into());
    *link.pair_on_post.lock().unwrap() = Some("machine-b".into());
    link.answers
        .lock()
        .unwrap()
        .push_back(MachineApiError::Revoked);
    let (status_tx, status_rx) = mpsc::channel();
    let factory = link.clone();
    let mut emitter = PushEmitter::with_link(
        on(),
        Some(status_tx),
        Arc::new(move || Box::new(factory.clone())),
    );
    emitter.offer(attention("old", AttentionKind::AttentionRaised));
    wait_for(|| link.batches.lock().unwrap().len() == 1);
    emitter.offer(attention("new", AttentionKind::AttentionRaised));
    wait_for(|| link.batches.lock().unwrap().len() == 2);
    drop(emitter);
    assert_eq!(link.revocations.load(Ordering::SeqCst), 0);
    assert!(status_rx.try_recv().is_err(), "no stale stop warning");
}
