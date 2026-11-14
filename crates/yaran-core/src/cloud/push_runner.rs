//! The `cloud-push` thread body: queue, machine-config cache, delivery and its outcomes.
//!
//! One `Runner` per emitter start. It sleeps until the next entry is due, a retry or
//! `min_interval_ms` window ends, or a second passes (TTL expiry), and classifies every
//! answer exhaustively (`Verdict`) into ack, retry with the same ids, drop, pause, revoke
//! or clock skew. Keyed statuses for the failures worth surfacing are built here.
//!
//! - Runs only on the `cloud-push` thread.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_runner.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::push_config
//! ├── cloud::push_emitter
//! ├── cloud::push_link
//! ├── cloud::push_queue
//! ├── engine
//! ├── status_text
//! ├── statusline
//! ├── watch::rule
//! ├── wire
//! └── worker
//! External: chrono, rand, std, tracing
//!
//! Used by:
//! cloud/push_runner.rs
//! ├── cloud
//! ├── cloud::push_emitter
//! └── cloud::push_emitter::tests
//! <module-headers:end>

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use rand::Rng;

use super::protocol::ErrorCode;
use super::protocol::machine::{Event, EventBatch, EventBatchResult, PushDetail};
use super::push_config::PushSettings;
use super::push_emitter::{CONFIG_RECHECK, Msg};
use super::push_link::{LinkError, MachineLink};
use super::push_queue::PushQueue;
use crate::engine::StatusUpdate;
use crate::status_text;
use crate::statusline::StatusTone;
use crate::watch::rule::WatchBackoff;
use crate::wire::status_keys::CLOUD_PUSH;
use crate::worker::WorkerEvent;

const BACKOFF: WatchBackoff = WatchBackoff {
    initial_ms: 2_000,
    max_ms: 120_000,
    multiplier: 2.0,
    jitter_ms: 1_000,
};
/// 02 caps a batch at 16; used until the org's config is known.
const DEFAULT_MAX_BATCH: usize = 16;
/// The longest the thread sleeps with nothing due (TTL expiry is checked on wake).
const IDLE_WAKE: Duration = Duration::from_secs(1);
/// The exhaustive classification of one `POST /v1/machine/events`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Delivered {
        acknowledged: HashSet<String>,
        push_enabled: bool,
    },
    Retry {
        after: Option<Duration>,
        error: String,
    },
    DropBatch {
        error: String,
    },
    Revoked,
    ClockSkew {
        server_time: Option<String>,
    },
}

pub(crate) fn classify(result: Result<EventBatchResult, LinkError>) -> Verdict {
    match result {
        Ok(r) => Verdict::Delivered {
            acknowledged: r.accepted.into_iter().chain(r.duplicates).collect(),
            push_enabled: r.push_enabled,
        },
        Err(err) => {
            let error = err.describe();
            match err {
                LinkError::Revoked => Verdict::Revoked,
                LinkError::Refused {
                    code: ErrorCode::MachineUnknown,
                    ..
                } => Verdict::Revoked,
                LinkError::ClockSkew { server_time } => Verdict::ClockSkew { server_time },
                LinkError::Refused {
                    retryable: true,
                    retry_after,
                    ..
                } => Verdict::Retry {
                    after: retry_after,
                    error,
                },
                LinkError::Server {
                    status,
                    retry_after,
                } if status == 429 || status >= 500 => Verdict::Retry {
                    after: retry_after,
                    error,
                },
                LinkError::Network(_) => Verdict::Retry { after: None, error },
                LinkError::Refused { .. } | LinkError::Server { .. } | LinkError::Malformed(_) => {
                    Verdict::DropBatch { error }
                }
            }
        }
    }
}

pub(crate) struct Runner {
    rx: Receiver<Msg>,
    link: Box<dyn MachineLink>,
    queue: PushQueue,
    status: Option<Sender<WorkerEvent>>,
    flush_on_exit: Arc<AtomicBool>,
    ttl: Duration,
    max_batch: usize,
    min_interval: Duration,
    minimal: bool,
    paused: bool,
    revoked: bool,
    config_due: bool,
    last_config_check: Option<Instant>,
    retry_at: Option<Instant>,
    next_send: Instant,
    attempt: u32,
    last_error: Option<String>,
    expiry_warned: bool,
}

impl Runner {
    pub(crate) fn new(
        rx: Receiver<Msg>,
        link: Box<dyn MachineLink>,
        s: PushSettings,
        status: Option<Sender<WorkerEvent>>,
        flush_on_exit: Arc<AtomicBool>,
    ) -> Self {
        Self {
            rx,
            link,
            queue: PushQueue::new(s.coalesce, s.offline_ttl),
            status,
            flush_on_exit,
            ttl: s.offline_ttl,
            max_batch: DEFAULT_MAX_BATCH,
            min_interval: Duration::ZERO,
            minimal: false,
            paused: false,
            revoked: false,
            config_due: true,
            last_config_check: None,
            retry_at: None,
            next_send: Instant::now(),
            attempt: 0,
            last_error: None,
            expiry_warned: false,
        }
    }

    pub(crate) fn run(mut self) {
        loop {
            match self.rx.recv_timeout(self.wake_in(Instant::now())) {
                Ok(Msg::Offer(event)) => {
                    if !self.revoked && !self.paused {
                        self.queue.offer(event, Instant::now());
                    }
                }
                Ok(Msg::Retune(s)) => {
                    self.queue.set_windows(s.coalesce, s.offline_ttl);
                    self.ttl = s.offline_ttl;
                    self.config_due = true;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            self.tick(Instant::now());
        }
        if self.flush_on_exit.load(Ordering::SeqCst) {
            self.shutdown_flush();
        }
    }

    fn wake_in(&self, now: Instant) -> Duration {
        let mut at = now + IDLE_WAKE;
        if !self.queue.is_empty() {
            for t in [self.queue.next_due(), self.retry_at, Some(self.next_send)]
                .into_iter()
                .flatten()
            {
                at = at.min(t);
            }
        }
        at.saturating_duration_since(now)
    }

    fn tick(&mut self, now: Instant) {
        if self.revoked {
            self.queue.discard_all();
            return;
        }
        let expired = self.queue.expire(now);
        if expired > 0 {
            self.warn_expired(expired);
        }
        if self.paused
            && self
                .last_config_check
                .is_none_or(|t| now - t >= CONFIG_RECHECK)
        {
            self.config_due = true;
        }
        if (self.queue.is_empty() && !(self.paused && self.config_due))
            || self.retry_at.is_some_and(|t| t > now)
            || self.next_send > now
        {
            return;
        }
        let Some(org) = self.link.org_name() else {
            let n = self.queue.discard_all();
            tracing::debug!(target: "yaran::cloud::push", dropped = n, "not paired; events dropped");
            return;
        };
        if self.config_due {
            self.refresh_config(&org, now);
        }
        if self.revoked || self.paused {
            self.queue.discard_all();
            return;
        }
        let batch = self.queue.due(now, self.max_batch);
        if batch.is_empty() {
            return;
        }
        let mut events: Vec<Event> = batch.iter().map(|q| q.event.clone()).collect();
        if self.minimal {
            events.iter_mut().for_each(strip_names);
        }
        let verdict = classify(self.link.post_events(&EventBatch { events }));
        self.next_send = Instant::now() + self.min_interval;
        match verdict {
            Verdict::Delivered {
                acknowledged,
                push_enabled,
            } => {
                self.queue.ack(batch, &acknowledged);
                self.attempt = 0;
                self.retry_at = None;
                self.last_error = None;
                if self.expiry_warned {
                    self.expiry_warned = false;
                    let c = self.queue.counts;
                    tracing::info!(target: "yaran::cloud::push", sent = c.sent, coalesced = c.coalesced, expired = c.expired, overflow = c.overflow, "phone notifications recovered");
                    self.post(
                        StatusTone::Info,
                        status_text![
                            "Phone notifications from this machine reach ",
                            n(org),
                            " again."
                        ],
                    );
                }
                if !push_enabled {
                    self.pause(now);
                }
            }
            Verdict::Retry { after, error } => {
                self.queue.nack(batch);
                self.back_off(now, after, error);
            }
            Verdict::DropBatch { error } => {
                tracing::warn!(target: "yaran::cloud::push", dropped = batch.len(), %error, "the control plane refused a batch of phone notifications; not retried");
            }
            Verdict::Revoked => self.revoke(&org),
            Verdict::ClockSkew { server_time } => {
                self.queue.nack(batch);
                self.back_off(now, None, "signature_expired".into());
                self.warn_skew(server_time);
            }
        }
    }

    fn refresh_config(&mut self, org: &str, now: Instant) {
        self.config_due = false;
        self.last_config_check = Some(now);
        match self.link.machine_config() {
            Ok(config) => {
                self.max_batch = config.events.max_batch.clamp(1, 16) as usize;
                self.min_interval =
                    Duration::from_millis(config.events.min_interval_ms.max(0) as u64);
                self.minimal = config.push.detail == PushDetail::Minimal;
                if config.push.enabled && self.paused {
                    tracing::info!(target: "yaran::cloud::push", "the org turned phone notifications back on; resuming");
                }
                self.paused = !config.push.enabled;
            }
            Err(
                LinkError::Revoked
                | LinkError::Refused {
                    code: ErrorCode::MachineUnknown,
                    ..
                },
            ) => self.revoke(org),
            Err(err) => {
                tracing::debug!(target: "yaran::cloud::push", error = %err.describe(), "machine config fetch failed; keeping the cached limits")
            }
        }
    }

    fn pause(&mut self, now: Instant) {
        let n = self.queue.discard_all();
        self.paused = true;
        self.last_config_check = Some(now);
        tracing::info!(target: "yaran::cloud::push", discarded = n, "the org has phone notifications off; pausing until its config says otherwise");
    }

    fn back_off(&mut self, now: Instant, after: Option<Duration>, error: String) {
        let delay = after.unwrap_or_else(|| {
            let jitter = rand::thread_rng().gen_range(0..=BACKOFF.jitter_ms);
            Duration::from_millis(BACKOFF.deterministic_delay_ms(self.attempt) + jitter)
        });
        self.attempt = self.attempt.saturating_add(1);
        self.retry_at = Some(now + delay);
        self.last_error = Some(error);
    }

    fn revoke(&mut self, org: &str) {
        self.revoked = true;
        self.queue.discard_all();
        self.link.report_revoked();
        tracing::warn!(target: "yaran::cloud::push", "the control plane says this machine is no longer paired; phone notifications stopped");
        self.post(
            StatusTone::Warning,
            status_text![
                "Phone notifications stopped: ",
                n(org),
                " says this machine is no longer paired. Run `yaran cloud login` to pair it again."
            ],
        );
    }

    fn warn_expired(&mut self, n: usize) {
        self.expiry_warned = true;
        let c = self.queue.counts;
        tracing::info!(target: "yaran::cloud::push", expired = n, sent = c.sent, coalesced = c.coalesced, overflow = c.overflow, "phone notifications expired unsent");
        let org = self
            .link
            .org_name()
            .unwrap_or_else(|| "the control plane".into());
        let error = self
            .last_error
            .clone()
            .unwrap_or_else(|| "no answer".into());
        let words = if n == 1 {
            "1 phone notification from this machine was".to_string()
        } else {
            format!("{n} phone notifications from this machine were")
        };
        self.post(
            StatusTone::Warning,
            status_text![
                format!("{words} dropped because "),
                n(org),
                format!(" could not be reached for {} ({error}). yaran keeps trying; run `yaran cloud status` to check the connection.", span_words(self.ttl)),
            ],
        );
    }

    fn warn_skew(&mut self, server_time: Option<String>) {
        let offset = server_time
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(&t).ok())
            .map(|t| (t.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_seconds());
        let measured = match offset {
            Some(s) => format!(
                "this machine's clock is {} seconds {} the control plane's",
                s.unsigned_abs(),
                if s > 0 { "behind" } else { "ahead of" }
            ),
            None => "this machine's clock is too far from the control plane's".into(),
        };
        self.post(
            StatusTone::Warning,
            status_text![format!("Phone notifications are failing: {measured}, so their signatures are refused. Fix the system clock (turn on automatic time setting); yaran keeps retrying.")],
        );
    }

    fn post(&self, tone: StatusTone, text: crate::status_text::StatusText) {
        if let Some(lane) = &self.status {
            let _ = lane.send(WorkerEvent::PollerStatus(StatusUpdate::keyed(
                CLOUD_PUSH, tone, text,
            )));
        }
    }

    /// One last attempt at idle clears (and pending exits); the result is only logged.
    fn shutdown_flush(&mut self) {
        let now = Instant::now();
        if self.revoked || self.paused {
            return;
        }
        let Some(_org) = self.link.org_name() else {
            return;
        };
        self.queue.queue_shutdown_clears(now);
        let batch = self.queue.due(now, self.max_batch);
        if batch.is_empty() {
            return;
        }
        let mut events: Vec<Event> = batch.into_iter().map(|q| q.event).collect();
        if self.minimal {
            events.iter_mut().for_each(strip_names);
        }
        let verdict = classify(self.link.post_events(&EventBatch { events }));
        tracing::info!(target: "yaran::cloud::push", delivered = matches!(verdict, Verdict::Delivered { .. }), "shutdown flush of phone notifications");
    }
}

/// `push.detail = minimal`: no label, no project (02; the Worker strips them again).
fn strip_names(event: &mut Event) {
    match event {
        Event::Attention(e) => {
            e.label = None;
            e.project = None;
        }
        Event::Exit(e) => {
            e.label = None;
            e.project = None;
        }
    }
}

fn span_words(d: Duration) -> String {
    let secs = d.as_secs();
    if secs >= 120 && secs.is_multiple_of(60) {
        format!("{} minutes", secs / 60)
    } else {
        format!("{secs} seconds")
    }
}
