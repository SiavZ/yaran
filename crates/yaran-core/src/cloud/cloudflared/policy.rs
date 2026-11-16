//! What the leg does when cloudflared exits or keeps failing: the pure exit table, the
//! restart backoff, the failure-run bookkeeping and the Unauthorized confirm window.
//!
//! - Pure; every clock is passed in, so the timing is table-tested.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/policy.rs
//! └── watch::rule
//! External: rand, std
//!
//! Used by:
//! cloud/cloudflared/policy.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::supervisor
//! ├── cloud::leg_run
//! └── cloud::leg_start
//! <module-headers:end>

use std::time::{Duration, Instant};

/// How a cloudflared child ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChildExit {
    /// It ended after yaran's own SIGTERM, whatever the code.
    AfterOurStop,
    Code(i32),
    Signal(i32),
    /// It could not be spawned at all.
    SpawnFailed(std::io::ErrorKind),
}

/// Whose binary was running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinarySource {
    Managed,
    User,
}

/// What to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    Done,
    /// The token was unreadable or invalid (255): ask the control plane, do not loop.
    Heal,
    /// cloudflared tried to self-update despite the flag: re-verify the managed binary.
    Reverify,
    Restart,
    /// The binary cannot be run at all.
    StopUnavailable,
}

/// The exit table (Design "Supervisor and policy").
pub fn plan_after_exit(exit: ChildExit, source: BinarySource) -> ExitAction {
    match (exit, source) {
        (ChildExit::AfterOurStop, _) => ExitAction::Done,
        (ChildExit::Code(255), _) => ExitAction::Heal,
        (ChildExit::Code(10 | 11), BinarySource::Managed) => ExitAction::Reverify,
        (ChildExit::Code(10 | 11), BinarySource::User) => ExitAction::Restart,
        (ChildExit::Code(_) | ChildExit::Signal(_), _) => ExitAction::Restart,
        (ChildExit::SpawnFailed(kind), _) => match kind {
            std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied => {
                ExitAction::StopUnavailable
            }
            _ => ExitAction::Restart,
        },
    }
}

/// Restart delays: `WatchBackoff`'s deterministic curve (multiplier fixed at 2) plus jitter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartBackoff {
    pub initial_ms: u64,
    pub max_ms: u64,
    pub jitter_ms: u64,
}

impl RestartBackoff {
    pub fn delay(&self, attempt: u32, rng: &mut impl rand::Rng) -> Duration {
        let curve = crate::watch::rule::WatchBackoff {
            initial_ms: self.initial_ms,
            max_ms: self.max_ms.max(self.initial_ms),
            multiplier: 2.0,
            jitter_ms: self.jitter_ms,
        };
        let jitter = if self.jitter_ms == 0 {
            0
        } else {
            rng.gen_range(0..=self.jitter_ms)
        };
        Duration::from_millis(curve.deterministic_delay_ms(attempt).saturating_add(jitter))
    }
}

/// A run of continuous Ready this long resets the failure run.
pub const READY_RESET: Duration = Duration::from_secs(60);
/// A failure run that never reaches Ready turns sticky after this many attempts.
pub const ESCALATE_AFTER: u32 = 5;

/// What the surfaces should be told about one more failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureNotice {
    /// First failure of a run: one `cloud-leg` Warning.
    First,
    /// The run has failed `ESCALATE_AFTER` times without Ready: make it sticky.
    Escalate,
    Quiet,
}

/// Failure-run bookkeeping across restarts.
#[derive(Debug, Default, Clone)]
pub struct FailureRun {
    attempt: u32,
    ready_since: Option<Instant>,
    reached_ready: bool,
}

impl FailureRun {
    /// The attempt number to feed the backoff for the next restart.
    pub fn attempt(&self) -> u32 {
        self.attempt
    }

    pub fn on_ready(&mut self, now: Instant) {
        self.ready_since.get_or_insert(now);
        self.reached_ready = true;
    }

    pub fn on_not_ready(&mut self, now: Instant) {
        if self
            .ready_since
            .is_some_and(|since| now - since >= READY_RESET)
        {
            *self = Self::default();
        }
        self.ready_since = None;
    }

    /// Record one failure (an exit that will be restarted).
    pub fn on_failure(&mut self, now: Instant) -> FailureNotice {
        self.on_not_ready(now);
        self.attempt += 1;
        if self.attempt == 1 {
            FailureNotice::First
        } else if self.attempt == ESCALATE_AFTER && !self.reached_ready {
            FailureNotice::Escalate
        } else {
            FailureNotice::Quiet
        }
    }
}

/// Watches for "Unauthorized seen, and `/ready` continuously not ready, for the window".
#[derive(Debug, Clone)]
pub struct UnauthorizedTracker {
    window: Duration,
    since: Option<Instant>,
}

impl UnauthorizedTracker {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            since: None,
        }
    }

    pub fn saw_unauthorized(&mut self, now: Instant) {
        self.since.get_or_insert(now);
    }

    /// A Ready answer clears the suspicion.
    pub fn ready(&mut self) {
        self.since = None;
    }

    /// Whether the window has held; when it has, the next window starts now (one heal per
    /// window).
    pub fn take_due(&mut self, now: Instant) -> bool {
        match self.since {
            Some(since) if now - since >= self.window => {
                self.since = Some(now);
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;

    #[test]
    fn the_exit_table() {
        use BinarySource::*;
        use ChildExit::*;
        use ExitAction::*;
        let cases = [
            (AfterOurStop, Managed, Done),
            (Code(0), Managed, Restart),
            (Code(1), User, Restart),
            (Signal(9), Managed, Restart),
            (Code(255), Managed, Heal),
            (Code(255), User, Heal),
            (Code(11), Managed, Reverify),
            (Code(10), User, Restart),
            (SpawnFailed(ErrorKind::NotFound), Managed, StopUnavailable),
            (
                SpawnFailed(ErrorKind::PermissionDenied),
                User,
                StopUnavailable,
            ),
            (SpawnFailed(ErrorKind::Interrupted), User, Restart),
        ];
        for (exit, source, want) in cases {
            assert_eq!(plan_after_exit(exit, source), want, "{exit:?} {source:?}");
        }
    }

    #[test]
    fn the_backoff_doubles_to_its_cap_with_bounded_jitter() {
        use rand::SeedableRng;
        let mut rng = rand::rngs::SmallRng::seed_from_u64(7);
        let b = RestartBackoff {
            initial_ms: 1000,
            max_ms: 5000,
            jitter_ms: 0,
        };
        let mut ms = |a| b.delay(a, &mut rng).as_millis();
        assert_eq!((ms(0), ms(1), ms(2), ms(3)), (1000, 2000, 4000, 5000));
        let j = RestartBackoff {
            jitter_ms: 300,
            ..b
        };
        let d = j.delay(0, &mut rng).as_millis();
        assert!((1000..=1300).contains(&d));
    }

    #[test]
    fn a_failure_run_warns_once_then_escalates_and_resets_after_a_minute_ready() {
        let t0 = Instant::now();
        let mut run = FailureRun::default();
        assert_eq!(run.on_failure(t0), FailureNotice::First);
        for _ in 2..ESCALATE_AFTER {
            assert_eq!(run.on_failure(t0), FailureNotice::Quiet);
        }
        assert_eq!(run.on_failure(t0), FailureNotice::Escalate);
        run.on_ready(t0);
        assert_eq!(run.on_failure(t0 + READY_RESET), FailureNotice::First);
        // A short Ready does not reset, and a run that once reached Ready never escalates.
        run.on_ready(t0);
        for _ in 0..ESCALATE_AFTER + 2 {
            assert_ne!(
                run.on_failure(t0 + Duration::from_secs(1)),
                FailureNotice::Escalate
            );
        }
    }

    #[test]
    fn unauthorized_needs_the_whole_window_and_fires_once_per_window() {
        let t0 = Instant::now();
        let w = Duration::from_secs(60);
        let mut t = UnauthorizedTracker::new(w);
        assert!(!t.take_due(t0 + w));
        t.saw_unauthorized(t0);
        t.saw_unauthorized(t0 + Duration::from_secs(30));
        assert!(!t.take_due(t0 + Duration::from_secs(59)));
        assert!(t.take_due(t0 + w));
        assert!(!t.take_due(t0 + w + Duration::from_secs(1)));
        assert!(t.take_due(t0 + w * 2));
        t.ready();
        assert!(!t.take_due(t0 + w * 5));
    }
}
