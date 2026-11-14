//! The cloud leg: one supervised cloudflared for this serve, on its own std thread.
//!
//! `CloudLeg::start` spawns the supervisor thread, which checks the preconditions
//! (`leg_start`), runs and restarts the child (`leg_run`) and reports every transition
//! through an injected sink, ending with exactly one [`CloudLegEvent::Stopped`]. The serve
//! loop (yaran-web `CloudLoop`) owns the handle and is the only one that starts or stops
//! a leg. [`CredentialsWatch`] polls the credentials revision so a login, logout or
//! rotate made by another process reaches the loop.
//!
//! - No tokio. The supervisor thread is long-lived and performs every spawn, which is what
//!   keeps Linux's `PR_SET_PDEATHSIG` (tied to the spawning thread) from firing early.
//! - A new leg joins the previous one first, so two children never share the token file.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg.rs
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::ready
//! ├── cloud::leg::tests
//! ├── cloud::leg_run
//! ├── cloud::leg_seam
//! └── cloud::leg_start
//! External: std
//!
//! Used by:
//! cloud/leg.rs
//! ├── cloud
//! ├── cloud::leg::tests
//! ├── cloud::leg_outcome
//! ├── cloud::leg_run
//! └── cloud::leg_start
//! <module-headers:end>

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use super::cloudflared::acquire::{BinaryUnavailable, ManagedSource};
use super::cloudflared::ready::Readiness;
use super::leg_seam::{CloudIdentity, CloudLegSettings};

/// Why a leg ended. Every variant but `Requested` is terminal until the next input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegStop {
    Requested,
    /// The credentials vanished between planning and start (a logout raced the start).
    CredentialsGone,
    Revoked {
        hostname: String,
    },
    BinaryUnavailable(BinaryUnavailable),
    /// Nothing answers on the loopback port the tunnel would forward to.
    NoLoopbackPrimary {
        port: u16,
    },
    OriginPortMismatch {
        paired: u16,
        serving: u16,
    },
    /// Unauthorized persisted after a successful rotate.
    HealFailed {
        hostname: String,
    },
}

/// What the leg reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudLegEvent {
    /// Downloading the managed binary, at most once a second.
    Acquiring {
        pct: Option<u8>,
        total_mb: Option<u64>,
    },
    /// A download finished and verified.
    Acquired {
        version: String,
    },
    /// A child was spawned on the credentials' `token_version`.
    Starting {
        token_version: i64,
    },
    Ready {
        connections: u32,
    },
    /// Ready was lost; cloudflared is reconnecting.
    NotReady,
    /// The child exited and is being restarted. `first` is the first failure of a run,
    /// `escalate` the run reaching the sticky threshold without Ready.
    Restarting {
        attempt: u32,
        delay: Duration,
        first: bool,
        escalate: bool,
    },
    /// Unauthorized held for the confirm window; asking the control plane.
    Healing,
    /// A one-off warning worth one sentence (support window, clock skew, network).
    Warning(String),
    Stopped(LegStop),
}

pub type LegSink = Arc<dyn Fn(CloudLegEvent) + Send + Sync>;

/// Asks cloudflared's metrics port whether it is ready (injected so tests need no HTTP).
pub type ReadyProbe = Arc<dyn Fn(u16) -> Readiness + Send + Sync>;

/// What a leg is started with.
#[derive(Clone)]
pub struct LegParams {
    pub settings: CloudLegSettings,
    /// yaran's loopback listener port (the tunnel's origin).
    pub serving_port: u16,
    pub download: ManagedSource,
    pub probe: ReadyProbe,
}

impl LegParams {
    pub fn new(settings: CloudLegSettings, serving_port: u16) -> Self {
        let timeout = Duration::from_secs(settings.request_timeout_seconds.max(1));
        Self {
            settings,
            serving_port,
            download: ManagedSource {
                base_url: super::cloudflared::acquire::DOWNLOAD_BASE.to_string(),
                request_timeout: timeout,
            },
            probe: Arc::new(super::cloudflared::ready::probe),
        }
    }
}

/// The handle the serve loop owns.
pub struct CloudLeg {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CloudLeg {
    /// Start a leg. `previous` (a leg already asked to stop) is joined on the new thread
    /// before anything else happens.
    pub fn start(
        params: LegParams,
        identity: Arc<dyn CloudIdentity>,
        sink: LegSink,
        previous: Option<CloudLeg>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new()
            .name("yaran-cloud-leg".into())
            .spawn(move || {
                if let Some(previous) = previous {
                    previous.request_stop();
                    previous.join();
                }
                let end = super::leg_start::prepare(&params, identity.as_ref(), &flag, &sink)
                    .and_then(|prepared| {
                        super::leg_run::run(&params, identity.as_ref(), prepared, &flag, &sink)
                    })
                    .unwrap_or_else(|stop| stop);
                identity.clear_leg_state();
                sink(CloudLegEvent::Stopped(end));
            })
            .expect("spawn the cloud leg thread");
        Self {
            stop,
            thread: Some(thread),
        }
    }

    /// Ask the leg to stop; returns at once. The thread stops the child and reports
    /// `Stopped(Requested)`.
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    /// Wait for the thread to end.
    pub fn join(mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(|t| t.is_finished())
    }
}

impl Drop for CloudLeg {
    fn drop(&mut self) {
        self.request_stop();
    }
}

/// Sleep up to `total`, waking early when `stop` is set. Answers whether it was stopped.
pub(crate) fn sleep_unless_stopped(stop: &AtomicBool, total: Duration) -> bool {
    let until = Instant::now() + total;
    loop {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let now = Instant::now();
        if now >= until {
            return false;
        }
        std::thread::sleep((until - now).min(Duration::from_millis(50)));
    }
}

/// Polls the credentials revision and the revocation signal; calls `on_change` once at
/// start and again whenever either moves. Stops when dropped.
pub struct CredentialsWatch {
    stop: Arc<AtomicBool>,
}

/// The credentials re-check cadence (mechanism, not preference: not a config key).
pub const CREDENTIALS_POLL: Duration = Duration::from_secs(2);

impl CredentialsWatch {
    pub fn spawn(
        identity: Arc<dyn CloudIdentity>,
        period: Duration,
        on_change: Box<dyn Fn() + Send>,
    ) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::Builder::new()
            .name("yaran-cloud-credentials".into())
            .spawn(move || {
                let mut last = (identity.revision(), identity.revoked());
                on_change();
                while !sleep_unless_stopped(&flag, period) {
                    let now = (identity.revision(), identity.revoked());
                    if now != last {
                        last = now;
                        on_change();
                    }
                }
            })
            .expect("spawn the credentials watch thread");
        Self { stop }
    }
}

impl Drop for CredentialsWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
#[path = "leg_tests.rs"]
mod tests;
