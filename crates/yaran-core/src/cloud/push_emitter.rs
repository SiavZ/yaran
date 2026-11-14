//! The `cloud-push` thread: turns attention edges into signed `POST /v1/machine/events`.
//!
//! The engine holds a `PushEmitter` and offers owned events with `try_send`, so the tick
//! never blocks: a full channel counts a drop. The thread coalesces through `PushQueue`,
//! reads pairing state from Phase 09 at flush time (unpaired drops quietly), honours the
//! org's cached `MachineConfig` (`push.enabled`, `push.detail`, `events`), retries with
//! the same event ids, and stops for good on revocation, handing the verdict to 09/10.
//!
//! - Owns its thread; the engine (`!Send`) only ever sees the handle.
//! - Statuses go out on the engine's worker lane under one key, warnings plus the one
//!   recovery info; success is silent.
//! - `Drop` flushes idle clears once and joins within `SHUTDOWN_JOIN`; turning push off
//!   stops without withdrawing anything already delivered.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_emitter.rs
//! ├── cloud::protocol::machine
//! ├── cloud::push_config
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_link
//! ├── cloud::push_runner
//! └── worker
//! External: std, tracing
//!
//! Used by:
//! cloud/push_emitter.rs
//! ├── cloud
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_runner
//! ├── engine::push_hook
//! ├── engine::push_hook::tests
//! └── yaran-core[test cloud_push_emitter]
//! <module-headers:end>

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(test)]
use std::sync::mpsc::Receiver;
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::protocol::machine::Event;
use super::push_config::PushSettings;
use super::push_link::{HttpMachineLink, MachineLink};
use super::push_runner::Runner;
use crate::worker::WorkerEvent;

/// Engine-to-thread slots; `offer` drops (and counts) rather than wait.
pub const CHANNEL_CAPACITY: usize = 512;
/// How often a paused emitter asks whether the org turned push back on.
pub const CONFIG_RECHECK: Duration = Duration::from_secs(15 * 60);
/// The bound on `Drop`'s join, mirroring `ConfigWriteQueue`.
pub const SHUTDOWN_JOIN: Duration = Duration::from_secs(2);

pub type LinkFactory = Arc<dyn Fn() -> Box<dyn MachineLink> + Send + Sync>;

#[derive(Debug)]
pub(crate) enum Msg {
    Offer(Event),
    Retune(PushSettings),
}

/// The engine's handle.
pub struct PushEmitter {
    status_lane: Option<Sender<WorkerEvent>>,
    factory: LinkFactory,
    tx: Option<SyncSender<Msg>>,
    worker: Option<(JoinHandle<()>, Arc<AtomicBool>)>,
    dropped: u64,
}

impl PushEmitter {
    /// What the engine builds. shortcut: unpaired until Phase 09's credentials store and
    /// `MachineApi` exist; then the factory builds a link over them.
    pub fn new(settings: PushSettings, status_lane: Option<Sender<WorkerEvent>>) -> Self {
        Self::with_link(
            settings,
            status_lane,
            Arc::new(|| Box::new(HttpMachineLink::unpaired())),
        )
    }

    pub fn with_link(
        settings: PushSettings,
        status_lane: Option<Sender<WorkerEvent>>,
        factory: LinkFactory,
    ) -> Self {
        let mut emitter = Self {
            status_lane,
            factory,
            tx: None,
            worker: None,
            dropped: 0,
        };
        emitter.retune(settings);
        emitter
    }

    /// A handle whose offers land in the returned receiver, no thread (engine tests).
    #[cfg(test)]
    pub(crate) fn capture(capacity: usize) -> (Self, Receiver<Msg>) {
        let (tx, rx) = mpsc::sync_channel(capacity);
        let mut emitter = Self::new(PushSettings::off(), None);
        emitter.tx = Some(tx);
        (emitter, rx)
    }

    pub fn is_on(&self) -> bool {
        self.tx.is_some()
    }

    /// Offers the channel refused (full or gone) since start.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Never blocks.
    pub fn offer(&mut self, event: Event) {
        let Some(tx) = &self.tx else { return };
        match tx.try_send(Msg::Offer(event)) {
            Ok(()) => {}
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.dropped += 1;
                tracing::debug!(target: "yaran::cloud::push", dropped = self.dropped, "push channel full; event dropped");
            }
        }
    }

    /// Starts, retunes or stops the thread; idempotent. A running thread rechecks the
    /// org's config on every retune. Never joins, so a reload never waits on the network.
    pub fn retune(&mut self, settings: PushSettings) {
        match (settings.enabled, self.tx.is_some()) {
            (true, false) => self.start(settings),
            (true, true) => {
                if let Some(tx) = &self.tx {
                    let _ = tx.try_send(Msg::Retune(settings));
                }
            }
            (false, true) => {
                // Disconnecting stops the thread after its current request, flushing nothing.
                self.tx = None;
                self.worker = None;
            }
            (false, false) => {}
        }
    }

    fn start(&mut self, settings: PushSettings) {
        let (tx, rx) = mpsc::sync_channel(CHANNEL_CAPACITY);
        let flush = Arc::new(AtomicBool::new(false));
        let runner = Runner::new(
            rx,
            (self.factory)(),
            settings,
            self.status_lane.clone(),
            flush.clone(),
        );
        match thread::Builder::new()
            .name("cloud-push".into())
            .spawn(move || runner.run())
        {
            Ok(handle) => {
                self.tx = Some(tx);
                self.worker = Some((handle, flush));
            }
            Err(err) => {
                tracing::warn!(target: "yaran::cloud::push", %err, "could not start the phone-notification thread; phone notifications stay off")
            }
        }
    }
}

impl Drop for PushEmitter {
    fn drop(&mut self) {
        let Some((handle, flush)) = self.worker.take() else {
            return;
        };
        flush.store(true, Ordering::SeqCst);
        self.tx = None;
        let (done_tx, done_rx) = mpsc::sync_channel::<()>(0);
        thread::spawn(move || {
            let _ = handle.join();
            let _ = done_tx.send(());
        });
        if done_rx.recv_timeout(SHUTDOWN_JOIN).is_err() {
            tracing::warn!(target: "yaran::cloud::push", "the phone-notification thread did not finish within its shutdown bound; abandoning it");
        }
    }
}

#[cfg(test)]
#[path = "push_emitter_tests.rs"]
mod tests;
