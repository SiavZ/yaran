//! The emitter's pending events: per-topic net-change coalescing, a hard bound and a TTL.
//!
//! An attention entry waits `coalesce` after its topic's first edge and is sent only if
//! its newest state differs from what the Worker last acknowledged for that topic, so a
//! raise cleared inside the window sends nothing. Exit events are one-shot: never
//! coalesced away, and they take over their topic (the phone shows the exit in place of
//! the attention notification), so a clear that follows an exit is not sent.
//!
//! - Pure, time injected; owned by the `cloud-push` thread.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_queue.rs
//! ├── cloud::protocol
//! └── cloud::protocol::machine
//! External: chrono, std, uuid
//!
//! Used by:
//! cloud/push_queue.rs
//! ├── cloud
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_runner
//! ├── engine::push_hook
//! └── yaran-core[test cloud_push_emitter]
//! <module-headers:end>

use std::collections::{HashSet, VecDeque};
use std::time::{Duration, Instant};

use super::protocol::machine::{AttentionEvent, AttentionKind, Event, RowStateToken};

/// Compile-time safety bound on pending events: far above any real burst (an agent edge
/// needs a view or an exit in between), small enough that an offline laptop's backlog is
/// a few kilobytes.
pub const MAX_PENDING: usize = 256;

/// A topic: 02's `topic(m, a, t)` without the machine (one queue per machine).
type Topic = (String, Option<String>);

/// A fresh idempotency key (UUID v4), kept unchanged across retries.
pub fn new_event_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 02 `Timestamp`: RFC 3339 UTC, seconds.
pub fn event_ts() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn id_of(event: &Event) -> &str {
    match event {
        Event::Attention(e) => &e.id,
        Event::Exit(e) => &e.id,
    }
}

fn topic_of(event: &Event) -> Topic {
    match event {
        Event::Attention(e) => (e.agent_id.clone(), e.tab_id.clone()),
        Event::Exit(e) => (e.agent_id.clone(), e.tab_id.clone()),
    }
}

fn attention_kind(event: &Event) -> Option<AttentionKind> {
    match event {
        Event::Attention(e) => Some(e.kind),
        Event::Exit(_) => None,
    }
}

#[derive(Debug, Clone)]
pub struct Queued {
    pub event: Event,
    topic: Topic,
    born: Instant,
    due_at: Instant,
}

impl Queued {
    pub fn id(&self) -> &str {
        id_of(&self.event)
    }
}

/// Running totals, logged by the emitter.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct QueueCounts {
    pub sent: u64,
    pub coalesced: u64,
    pub expired: u64,
    pub overflow: u64,
}

#[derive(Debug)]
pub struct PushQueue {
    pending: VecDeque<Queued>,
    /// Topics whose last acknowledged attention state is "raised".
    raised: HashSet<Topic>,
    coalesce: Duration,
    ttl: Duration,
    pub counts: QueueCounts,
}

impl PushQueue {
    pub fn new(coalesce: Duration, ttl: Duration) -> Self {
        Self {
            pending: VecDeque::new(),
            raised: HashSet::new(),
            coalesce,
            ttl,
            counts: QueueCounts::default(),
        }
    }

    pub fn set_windows(&mut self, coalesce: Duration, ttl: Duration) {
        self.coalesce = coalesce;
        self.ttl = ttl;
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }

    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn pending_attention(&self, topic: &Topic) -> Option<usize> {
        self.pending
            .iter()
            .position(|q| &q.topic == topic && attention_kind(&q.event).is_some())
    }

    pub fn offer(&mut self, event: Event, now: Instant) {
        let topic = topic_of(&event);
        match attention_kind(&event) {
            Some(_) => {
                // Newest state wins; the window still runs from the topic's first edge.
                if let Some(i) = self.pending_attention(&topic) {
                    let entry = &mut self.pending[i];
                    entry.event = event;
                    entry.born = now;
                    self.counts.coalesced += 1;
                    return;
                }
            }
            None => {
                // The exit replaces the attention notification on the phone.
                if let Some(i) = self.pending_attention(&topic) {
                    self.pending.remove(i);
                    self.counts.coalesced += 1;
                }
                self.raised.remove(&topic);
            }
        }
        if self.pending.len() >= MAX_PENDING {
            self.pending.pop_front();
            self.counts.overflow += 1;
        }
        self.pending.push_back(Queued {
            event,
            topic,
            born: now,
            due_at: now + self.coalesce,
        });
    }

    /// Whether this attention entry would change nothing the Worker already has.
    fn is_no_change(&self, q: &Queued) -> bool {
        match attention_kind(&q.event) {
            Some(AttentionKind::AttentionRaised) => self.raised.contains(&q.topic),
            Some(AttentionKind::AttentionCleared) => !self.raised.contains(&q.topic),
            None => false,
        }
    }

    /// Takes up to `max_batch` due entries (oldest first), dropping net no-ops.
    pub fn due(&mut self, now: Instant, max_batch: usize) -> Vec<Queued> {
        let mut out = Vec::new();
        let mut keep = VecDeque::with_capacity(self.pending.len());
        while let Some(q) = self.pending.pop_front() {
            if q.due_at > now || out.len() >= max_batch {
                keep.push_back(q);
            } else if self.is_no_change(&q) {
                self.counts.coalesced += 1;
            } else {
                out.push(q);
            }
        }
        self.pending = keep;
        out
    }

    /// The earliest moment an entry becomes due.
    pub fn next_due(&self) -> Option<Instant> {
        self.pending.iter().map(|q| q.due_at).min()
    }

    /// Settles a delivered batch: ids in `acknowledged` (02 `accepted` ∪ `duplicates`)
    /// move their topic's acknowledged state; the Worker answered for the whole batch, so
    /// an id it did not list is not retried.
    pub fn ack(&mut self, batch: Vec<Queued>, acknowledged: &HashSet<String>) -> usize {
        let mut acked = 0;
        for q in batch {
            if !acknowledged.contains(q.id()) {
                continue;
            }
            acked += 1;
            match attention_kind(&q.event) {
                Some(AttentionKind::AttentionRaised) => {
                    self.raised.insert(q.topic);
                }
                Some(AttentionKind::AttentionCleared) => {
                    self.raised.remove(&q.topic);
                }
                None => {}
            }
        }
        self.counts.sent += acked as u64;
        acked
    }

    /// Puts an undelivered batch back at the front, ids unchanged, unless a newer state
    /// for the same topic arrived meanwhile.
    pub fn nack(&mut self, batch: Vec<Queued>) {
        for q in batch.into_iter().rev() {
            let superseded =
                attention_kind(&q.event).is_some() && self.pending_attention(&q.topic).is_some();
            if !superseded {
                self.pending.push_front(q);
            }
        }
    }

    /// Drops entries older than the TTL; returns how many.
    pub fn expire(&mut self, now: Instant) -> usize {
        let before = self.pending.len();
        let ttl = self.ttl;
        self.pending
            .retain(|q| now.saturating_duration_since(q.born) < ttl);
        let expired = before - self.pending.len();
        self.counts.expired += expired as u64;
        expired
    }

    /// Drops every pending entry (paused, unpaired, revoked); returns how many.
    pub fn discard_all(&mut self) -> usize {
        let n = self.pending.len();
        self.pending.clear();
        n
    }

    /// At shutdown the agents die with the process: every pending attention entry becomes
    /// a clear, and every acknowledged raise without one gets a clear (state `idle`, 02's
    /// default when the emitter cannot tell), all due at once. `due` then drops the clears
    /// the Worker does not need.
    pub fn queue_shutdown_clears(&mut self, now: Instant) {
        for q in self.pending.iter_mut() {
            if attention_kind(&q.event).is_some() {
                q.event = idle_clear(q.topic.clone());
            }
            q.due_at = now;
        }
        let mut topics: Vec<Topic> = self.raised.iter().cloned().collect();
        topics.sort();
        for topic in topics {
            if self.pending_attention(&topic).is_none() {
                self.pending.push_back(Queued {
                    event: idle_clear(topic.clone()),
                    topic,
                    born: now,
                    due_at: now,
                });
            }
        }
    }
}

fn idle_clear((agent_id, tab_id): Topic) -> Event {
    Event::Attention(AttentionEvent {
        id: new_event_id(),
        kind: AttentionKind::AttentionCleared,
        ts: event_ts(),
        agent_id,
        tab_id,
        state: RowStateToken::Idle,
        project: None,
        label: None,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::cloud::protocol::Validate;
    use crate::cloud::protocol::machine::{EndingToken, ExitEvent, ExitKind};

    const W: Duration = Duration::from_secs(2);
    const TTL: Duration = Duration::from_secs(600);

    pub(crate) fn attention(agent: &str, kind: AttentionKind) -> Event {
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
            project: Some("proj".into()),
            label: Some("label".into()),
        })
    }

    pub(crate) fn exit(agent: &str) -> Event {
        Event::Exit(ExitEvent {
            id: new_event_id(),
            kind: ExitKind::AgentExitedBadly,
            ts: event_ts(),
            agent_id: agent.into(),
            tab_id: None,
            ending: EndingToken::Exited,
            exit_status: Some(1),
            project: None,
            label: None,
        })
    }

    const RAISE: AttentionKind = AttentionKind::AttentionRaised;
    const CLEAR: AttentionKind = AttentionKind::AttentionCleared;

    fn ack_all(q: &mut PushQueue, batch: Vec<Queued>) {
        let ids = batch.iter().map(|q| q.id().to_string()).collect();
        q.ack(batch, &ids);
    }

    #[test]
    fn push_queue_raise_then_clear_inside_the_window_sends_nothing() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        q.offer(attention("a", CLEAR), t0 + Duration::from_millis(500));
        assert!(q.due(t0 + W, 16).is_empty());
        assert!(q.is_empty());
    }

    #[test]
    fn push_queue_raise_after_the_window_sends_once() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        assert!(q.due(t0 + Duration::from_secs(1), 16).is_empty());
        let batch = q.due(t0 + W, 16);
        assert_eq!(batch.len(), 1);
        assert!(batch[0].event.validate().is_ok());
        ack_all(&mut q, batch);
        // A second raise for an acknowledged raised topic is no change.
        q.offer(attention("a", RAISE), t0 + W);
        assert!(q.due(t0 + W * 2, 16).is_empty());
    }

    #[test]
    fn push_queue_clear_is_sent_only_after_an_acknowledged_raise() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", CLEAR), t0);
        assert!(
            q.due(t0 + W, 16).is_empty(),
            "nothing raised, nothing to clear"
        );
        q.offer(attention("a", RAISE), t0);
        let batch = q.due(t0 + W, 16);
        ack_all(&mut q, batch);
        q.offer(attention("a", CLEAR), t0 + W);
        assert_eq!(q.due(t0 + W * 2, 16).len(), 1);
    }

    #[test]
    fn push_queue_exit_is_never_coalesced_and_takes_over_its_topic() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        let batch = q.due(t0 + W, 16);
        ack_all(&mut q, batch);
        q.offer(exit("a"), t0 + W);
        q.offer(exit("a"), t0 + W);
        // The clear that follows the exit (provider gone) adds nothing.
        q.offer(attention("a", CLEAR), t0 + W);
        let batch = q.due(t0 + W * 2, 16);
        assert_eq!(batch.len(), 2);
        assert!(batch.iter().all(|b| matches!(b.event, Event::Exit(_))));
    }

    #[test]
    fn push_queue_capacity_drops_the_oldest() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        let first = exit("a");
        let first_id = id_of(&first).to_string();
        q.offer(first, t0);
        for _ in 0..MAX_PENDING {
            q.offer(exit("a"), t0);
        }
        assert_eq!(q.len(), MAX_PENDING);
        assert_eq!(q.counts.overflow, 1);
        assert!(q.pending.iter().all(|e| e.id() != first_id));
    }

    #[test]
    fn push_queue_ttl_expiry_counts() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, Duration::from_secs(30));
        q.offer(exit("a"), t0);
        q.offer(exit("b"), t0 + Duration::from_secs(20));
        assert_eq!(q.expire(t0 + Duration::from_secs(31)), 1);
        assert_eq!(q.counts.expired, 1);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn push_queue_batches_respect_max_batch() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        for i in 0..20 {
            q.offer(exit(&format!("a{i}")), t0);
        }
        assert_eq!(q.due(t0 + W, 16).len(), 16);
        assert_eq!(q.due(t0 + W, 3).len(), 3);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn push_queue_a_nacked_event_keeps_its_id() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        let batch = q.due(t0 + W, 16);
        let id = batch[0].id().to_string();
        q.nack(batch);
        let again = q.due(t0 + W, 16);
        assert_eq!(again[0].id(), id);
    }

    #[test]
    fn push_queue_duplicates_count_as_acknowledged() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        let batch = q.due(t0 + W, 16);
        // The emitter folds `duplicates` into the acknowledged set.
        let dup: HashSet<String> = [batch[0].id().to_string()].into();
        assert_eq!(q.ack(batch, &dup), 1);
        q.offer(attention("a", CLEAR), t0 + W);
        assert_eq!(
            q.due(t0 + W * 2, 16).len(),
            1,
            "the raise counted as landed"
        );
    }

    #[test]
    fn push_queue_shutdown_turns_acknowledged_raises_into_idle_clears() {
        let t0 = Instant::now();
        let mut q = PushQueue::new(W, TTL);
        q.offer(attention("a", RAISE), t0);
        q.offer(attention("b", RAISE), t0);
        let batch = q.due(t0 + W, 16);
        let only_a = [batch[0].id().to_string()].into();
        q.ack(batch, &only_a);
        // A raise still waiting in its window is never sent for a dying agent.
        q.offer(attention("c", RAISE), t0 + W);
        q.queue_shutdown_clears(t0 + W);
        let out = q.due(t0 + W, 16);
        assert_eq!(out.len(), 1);
        match &out[0].event {
            Event::Attention(e) => {
                assert_eq!(e.kind, CLEAR);
                assert_eq!(e.state, RowStateToken::Idle);
                assert!(out[0].event.validate().is_ok());
            }
            Event::Exit(_) => panic!("expected a clear"),
        }
    }
}
