//! Unit tests for the emitter handle and its response classification; the HTTP paths are
//! covered against a mock Worker in `tests/cloud_push_emitter.rs`.
//!
//! - Test-only (`#[cfg(test)]` child of `cloud::push_emitter`).
//!
//! <module-headers:begin>
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

fn emitter(paired: bool) -> (PushEmitter, Arc<Mutex<Calls>>, Arc<AtomicUsize>) {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let built = Arc::new(AtomicUsize::new(0));
    let factory: LinkFactory = {
        let (calls, built) = (calls.clone(), built.clone());
        Arc::new(move || {
            built.fetch_add(1, Ordering::SeqCst);
            Box::new(FakeLink {
                paired,
                calls: calls.clone(),
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
    assert!(calls.lock().unwrap().batches.is_empty());
}
