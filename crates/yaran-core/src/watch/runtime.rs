//! Per-tab runtime state for the watch engine, owned by
//! [`crate::engine::Engine`] and driven by `Engine::tick_watch_rules`.
//!
//! Keyed by TAB id, not session id: an upstream agent can run several tabs,
//! each with its own provider, and a rule set belongs to the provider whose
//! output it reads.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::ids::TabId;

use super::{WatchEngine, WatchRule};

/// The text a tab's rules last ran on, with the terminal generation it came
/// from, when it was scanned, and its fingerprint, so the rules reuse the key
/// instead of rehashing the same text on every tick.
#[derive(Clone)]
pub struct WatchSnapshot {
    pub generation: u64,
    pub scanned_at: Instant,
    pub text: std::sync::Arc<str>,
    pub key: super::SnapshotKey,
}

/// One tab's attached engine plus the inputs it was built from, so a config
/// reload that changes the rules (or the session settings that add the
/// built-in auto-clear rule) rebuilds it, and one that does not keeps its
/// attempt counters and cooldowns.
pub struct AttachedWatch {
    pub engine: WatchEngine,
    /// The exact rule list the engine was built from (user rules, then the
    /// built-in auto-clear and auto-compact rules when attached).
    pub rules: Vec<WatchRule>,
    /// Arm overrides that were applied at build time, by rule index.
    pub arm_overrides: Vec<(usize, bool)>,
    /// Index of the built-in auto-clear rule, when attached.
    pub auto_clear_idx: Option<usize>,
    /// Index of the built-in auto-compact rule, when attached.
    pub auto_compact_idx: Option<usize>,
}

/// What the engine knows about one compact instructions file, keyed in
/// [`WatchRuntime::compact_commands`] by the path as configured.
#[derive(Clone, Debug, Default)]
pub struct CompactCommandCache {
    /// The line the auto-compact rule types, once a read has finished.
    pub command: Option<String>,
    /// When the last read finished. A read older than the refresh interval is
    /// repeated, so an edited file is picked up without a restart.
    pub loaded_at: Option<Instant>,
    /// A read is in flight; no second one starts until it lands.
    pub loading: bool,
    /// The warning the last read logged, so an unchanged problem is logged
    /// once rather than on every refresh.
    pub warning: Option<String>,
}

#[derive(Default)]
pub struct WatchRuntime {
    pub attached: HashMap<TabId, AttachedWatch>,
    /// Tabs whose last `send_text` body is typed but whose submit key is
    /// deferred to a later tick (two-phase delivery), with when the body went.
    pub pending_enters: HashMap<TabId, Instant>,
    /// Tabs whose watch rules are paused until the given instant (after an
    /// AMQ inject wrote a postscript that could itself match a rule). When the
    /// window ends the engine rebaselines once, absorbing any stale match.
    pub suppress_until: HashMap<TabId, Instant>,
    /// The `/compact` line each compact instructions file builds, keyed by the
    /// path as configured. A worker thread reads the files; the tick only
    /// looks up what it found.
    pub compact_commands: HashMap<String, CompactCommandCache>,
    /// The last text each tab's rules were run against, the terminal
    /// generation it came from and when it was scanned. A tab whose terminal
    /// has not changed reuses it instead of rescanning its grid on every UI
    /// tick, and one that keeps changing is rescanned at most every
    /// `WATCH_RESCAN_INTERVAL`.
    pub last_snapshot: HashMap<TabId, WatchSnapshot>,
    /// The tab the last capped rescan reached. The next tick's rescans start
    /// after it, so the per-tick budget goes round-robin.
    pub rescan_cursor: Option<TabId>,
    /// How long after a tab's PTY is spawned (or adopted) the built-in rules
    /// take its screen as already seen. `None` is the engine's
    /// `WATCH_BUILT_IN_STARTUP_SETTLE`; tests that are not about this window
    /// set `Some(Duration::ZERO)`.
    pub built_in_startup_settle: Option<Duration>,
    /// How many grid rescans ticks have performed. Tests pin the per-tick cap.
    #[cfg(test)]
    pub rescans: usize,
    /// How many times a tick consulted the auto-clear guard. Tests pin that a
    /// quiet screen never pays for the guard's mailbox reads.
    #[cfg(test)]
    pub auto_clear_guard_checks: std::sync::atomic::AtomicUsize,
    /// How many times a tick consulted the auto-compact guard, for the same
    /// reason.
    #[cfg(test)]
    pub auto_compact_guard_checks: std::sync::atomic::AtomicUsize,
}

impl WatchRuntime {
    /// Forget everything about a tab. Called from the engine's tab teardown so
    /// a relaunched tab starts with fresh budgets and no stale deferred Enter.
    pub fn forget(&mut self, tab_id: &crate::ids::TabIdRef) {
        self.attached.remove(tab_id);
        self.pending_enters.remove(tab_id);
        self.suppress_until.remove(tab_id);
        self.last_snapshot.remove(tab_id);
    }
}
