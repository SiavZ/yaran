//! Engine half of the watch-rule feature: keep one [`WatchEngine`] per live
//! agent tab in step with config, feed it the tab's recent output every tick,
//! and carry out what it decides.
//!
//! Both surfaces call [`Engine::tick_watch_rules`] exactly once per tick (the
//! TUI run loop, or the web actor's maintenance sweep when no TUI is running),
//! the same contract as `poll_pty_activity`, so a rule never fires twice.

use std::time::{Duration, Instant};

use crate::ids::{TabId, TabIdRef};
use crate::watch::builtin::CompactCommandLoad;
use crate::watch::delivery::{
    MIN_ENTER_PHASE_DELAY_MS, effective_enter_phase_delay, inject_body_bytes_for_provider,
    submit_key_bytes_for_provider,
};
use crate::watch::runtime::{AttachedWatch, WatchSnapshot};
use crate::watch::{RuleSnapshot, SnapshotKey, WatchEffect, WatchEngine, WatchRule, WatchRuleKind};

use super::amq::WATCH_SUPPRESS_AFTER_INJECT;
use super::{Engine, EventReaction, StatusUpdate};

/// How many of the newest non-blank rows a rule is matched against. Enough
/// for an error block plus the prompt under it, small enough that an old
/// incident scrolls out and a new one reads as new.
pub const WATCH_SCAN_ROWS: usize = 30;

/// A tab the user typed into within this window is left alone: a rule must not
/// type into the middle of the user's own prompt. Short on purpose, because
/// rules react to terminal states (the fork capped its quiet window at 5s).
pub const WATCH_TYPING_QUIET: Duration = Duration::from_secs(5);

/// The least time between two rescans of one tab whose screen keeps changing.
/// A working agent redraws a spinner several times a second, so its screen is
/// new on nearly every UI tick; rescanning and re-matching all of them on
/// every tick was the UI thread's largest remaining cost with dozens of busy
/// agents. Well under the shortest rule backoff in use (250 ms), so a rule
/// still sees a new match within one interval. Clocks (pending fires,
/// cooldowns) keep advancing every tick on the text from the last rescan.
pub const WATCH_RESCAN_INTERVAL: Duration = Duration::from_millis(200);

/// The rescan budget of one tick is the tab count split over this many ticks,
/// so a herd of tabs that fall due together is drained in at most this many
/// ticks. At the UI's tick rate that stays well inside one more
/// WATCH_RESCAN_INTERVAL.
pub const WATCH_RESCAN_SPREAD_TICKS: usize = 4;

/// Fewer tabs than this are all rescanned in one tick: spreading a handful
/// buys nothing and would only delay them.
pub const WATCH_MIN_RESCANS_PER_TICK: usize = 4;

/// How long a read of a compact instructions file stays current. An older one
/// is repeated in the background, so an edited file reaches the rule without a
/// restart.
pub const COMPACT_INSTRUCTIONS_REFRESH: Duration = Duration::from_secs(30);

/// How many changed tabs one tick may rescan, given `tabs` attached tabs.
pub fn watch_rescans_per_tick(tabs: usize) -> usize {
    tabs.div_ceil(WATCH_RESCAN_SPREAD_TICKS)
        .max(WATCH_MIN_RESCANS_PER_TICK)
}

/// The per-session inputs the watch engine reads from the session settings
/// store (Worker mode + the auto-clear and auto-compact opt-ins, and manual
/// arm overrides).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchSessionSettings {
    /// Worker mode AND auto-clear-on-task-done both on: attach the built-in
    /// auto-clear rule. Asymmetric default: off.
    pub auto_clear: bool,
    /// Worker mode AND auto-compact-on-`[compact]` both on: attach the
    /// built-in auto-compact rule once its instructions file has been read.
    pub auto_compact: bool,
    /// The compact instructions file, as configured (the session's own path,
    /// else the global one). Meaningful only when `auto_compact` is on.
    pub compact_instructions_path: String,
    /// Manual arm (`true`) / disarm (`false`) overrides by rule index into the
    /// provider's `[[providers.<name>.watch]]` array, sorted by index.
    pub arm_overrides: Vec<(usize, bool)>,
}

/// One row of the watch-rules list: a rule on a live tab.
#[derive(Clone, Debug)]
pub struct WatchRuleRow {
    pub tab_id: TabId,
    pub session_id: String,
    pub snapshot: RuleSnapshot,
    /// A built-in rule (auto-clear or auto-compact). Not user-toggleable from
    /// the list.
    pub built_in: bool,
}

/// What a tab's engine should be built from.
struct DesiredWatch {
    rules: Vec<WatchRule>,
    overrides: Vec<(usize, bool)>,
    auto_clear_idx: Option<usize>,
    auto_compact_idx: Option<usize>,
}

impl Engine {
    /// Settings the watch engine needs for `session_id`.
    /// Auto-clear and auto-compact each need BOTH Worker mode and their own
    /// explicit opt-in (the operator opts in twice); a missing record is the
    /// safe default.
    pub fn watch_session_settings(&self, session_id: &str) -> WatchSessionSettings {
        let Some(s) = self.session_settings(session_id) else {
            return WatchSessionSettings::default();
        };
        let mut arm_overrides: Vec<(usize, bool)> =
            s.watch_rule_arm.iter().map(|(i, a)| (*i, *a)).collect();
        arm_overrides.sort_unstable();
        let worker = s.mode == crate::session_settings::ContextMode::Worker;
        WatchSessionSettings {
            auto_clear: worker && s.auto_clear_on_task_done,
            auto_compact: worker && s.auto_compact_on_compact,
            compact_instructions_path: s
                .effective_compact_instructions_path(
                    &self.config.amq.inject.compact_instructions_path,
                )
                .to_string(),
            arm_overrides,
        }
    }

    /// Whether the built-in auto-clear rule must hold off this tick: the agent
    /// is busy, AMQ mail is pending for it, or it collaborated recently. A
    /// suppressed tick rebaselines the rule, so a sentinel seen while held
    /// never fires later.
    ///
    /// The AMQ side owns the answer (busy markers, queued wakes, pending
    /// mail, the collaboration quiet window): see
    /// [`Engine::amq_blocks_auto_clear`].
    pub fn watch_auto_clear_suppressed(&self, _tab_id: &TabIdRef, session_id: &str) -> bool {
        #[cfg(test)]
        self.watch
            .auto_clear_guard_checks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.amq_blocks_auto_clear(session_id)
    }

    /// Whether the built-in auto-compact rule must hold off this tick. The
    /// same holds as auto-clear (see [`Self::watch_auto_clear_suppressed`]),
    /// answered by [`Engine::amq_blocks_auto_compact`].
    pub fn watch_auto_compact_suppressed(&self, _tab_id: &TabIdRef, session_id: &str) -> bool {
        #[cfg(test)]
        self.watch
            .auto_compact_guard_checks
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.amq_blocks_auto_compact(session_id)
    }

    /// Pause a tab's watch rules until `until`. An AMQ inject calls this after
    /// typing a postscript that may itself match a rule (the task-done
    /// sentinel), and a built-in rule calls it after it fires, so a sentinel
    /// still on screen cannot fire the other built-in; when the window ends
    /// the rules rebaseline once so that text never fires.
    pub fn suppress_watch_rules(&mut self, tab_id: &TabIdRef, until: Instant) {
        self.watch.suppress_until.insert(tab_id.to_owned(), until);
    }

    /// The rules a tab should be running right now, or `None` when it should
    /// have no engine.
    fn desired_watch(&self, tab_id: &TabIdRef) -> Option<DesiredWatch> {
        let session_id = self.owning_session_for_tab(tab_id.as_str())?;
        let session = self.session_by_id(&session_id)?;
        let provider = self.tab_running_provider(session, tab_id);
        let mut rules = self
            .config
            .providers
            .get(provider.as_str())
            .map(|cfg| cfg.watch.clone())
            .unwrap_or_default();
        let settings = self.watch_session_settings(&session_id);
        let auto_clear_idx = if settings.auto_clear {
            let clear = crate::watch::builtin::provider_clear_command(&provider);
            rules.push(crate::watch::builtin::auto_clear_rule_for(clear));
            Some(rules.len() - 1)
        } else {
            None
        };
        // Attached only once the instructions file has been read: until then
        // there is no line to type, and the file is never read here.
        let compact_command = settings
            .auto_compact
            .then(|| self.watch.compact_commands.get(&settings.compact_instructions_path))
            .flatten()
            .and_then(|cache| cache.command.as_deref());
        let auto_compact_idx = compact_command.map(|command| {
            rules.push(crate::watch::builtin::auto_compact_rule_for(command));
            rules.len() - 1
        });
        if rules.is_empty() {
            return None;
        }
        Some(DesiredWatch {
            rules,
            overrides: settings.arm_overrides,
            auto_clear_idx,
            auto_compact_idx,
        })
    }

    /// Start a background read of each compact instructions file a live
    /// auto-compact Worker needs and that has not been read within
    /// [`COMPACT_INSTRUCTIONS_REFRESH`]. This runs on the UI thread every
    /// tick, so it only decides; the read happens on a worker thread and comes
    /// back as [`crate::worker::WorkerEvent::CompactInstructionsLoaded`].
    fn request_compact_command_loads(&mut self, tabs: &[TabId], now: Instant) {
        let mut wanted: Vec<String> = Vec::new();
        for tab in tabs {
            let Some(session_id) = self.owning_session_for_tab(tab.as_str()) else {
                continue;
            };
            let settings = self.watch_session_settings(&session_id);
            if settings.auto_compact && !wanted.contains(&settings.compact_instructions_path) {
                wanted.push(settings.compact_instructions_path);
            }
        }
        for raw_path in wanted {
            let cache = self
                .watch
                .compact_commands
                .entry(raw_path.clone())
                .or_default();
            let current = cache
                .loaded_at
                .is_some_and(|at| now.duration_since(at) < COMPACT_INSTRUCTIONS_REFRESH);
            if cache.loading || current {
                continue;
            }
            cache.loading = true;
            let tx = self.worker_tx.clone();
            let thread_path = raw_path.clone();
            let spawned = std::thread::Builder::new()
                .name("compact-instructions".to_string())
                .spawn(move || {
                    let load = crate::watch::builtin::load_compact_command(&thread_path);
                    let _ = tx.send(crate::worker::WorkerEvent::CompactInstructionsLoaded {
                        raw_path: thread_path,
                        load,
                    });
                });
            if let Err(err) = spawned {
                // Released so a later tick tries again.
                crate::logger::warn(&format!(
                    "[watch] could not start a read of compact instructions {raw_path:?}: {err}"
                ));
                if let Some(cache) = self.watch.compact_commands.get_mut(&raw_path) {
                    cache.loading = false;
                }
            }
        }
    }

    /// A compact instructions read finished: record the line to type. The
    /// next sync attaches (or, when the line changed, rebuilds) the rule.
    /// A fallback to a bare `/compact` is logged when its reason changes, not
    /// on every refresh.
    pub(crate) fn process_compact_instructions_loaded(
        &mut self,
        raw_path: String,
        load: CompactCommandLoad,
    ) -> EventReaction {
        let cache = self.watch.compact_commands.entry(raw_path).or_default();
        cache.loading = false;
        cache.loaded_at = Some(Instant::now());
        cache.command = Some(load.command);
        if cache.warning != load.warning {
            if let Some(warning) = &load.warning {
                crate::logger::warn(&format!("[watch] {warning}"));
            }
            cache.warning = load.warning;
        }
        EventReaction::Nothing
    }

    /// Attach, rebuild or drop each live tab's engine so it matches config.
    /// An unchanged rule set keeps its engine (and so its attempt counts and
    /// cooldowns); a changed one is rebuilt from scratch.
    fn sync_watch_engines(&mut self, statuses: &mut Vec<StatusUpdate>) {
        self.watch
            .attached
            .retain(|tab, _| self.providers.contains_key(tab.as_ref_id()));
        let tabs: Vec<TabId> = self.providers.keys().cloned().collect();
        self.request_compact_command_loads(&tabs, Instant::now());
        for tab in tabs {
            let desired = self.desired_watch(tab.as_ref_id());
            let Some(DesiredWatch {
                rules,
                overrides,
                auto_clear_idx,
                auto_compact_idx,
            }) = desired
            else {
                self.watch.attached.remove(&tab);
                continue;
            };
            if let Some(current) = self.watch.attached.get(&tab)
                && current.rules == rules
                && current.arm_overrides == overrides
            {
                continue;
            }
            let (mut engine, errors) = WatchEngine::new(tab.as_str(), &rules);
            for err in errors {
                crate::logger::warn(&format!("[watch] tab {tab}: {err}"));
                statuses.push(StatusUpdate::warning(err));
            }
            for &(idx, armed) in &overrides {
                // A stale index (the config shrank) is ignored, and the
                // built-in rules' indexes are reserved against forged overrides.
                if idx >= engine.rule_count()
                    || Some(idx) == auto_clear_idx
                    || Some(idx) == auto_compact_idx
                {
                    continue;
                }
                if armed {
                    engine.rearm(idx);
                } else {
                    engine.disarm(idx);
                }
            }
            self.carry_built_in_baselines(&tab, &mut engine, auto_clear_idx, auto_compact_idx);
            self.watch.attached.insert(
                tab,
                AttachedWatch {
                    engine,
                    rules,
                    arm_overrides: overrides,
                    auto_clear_idx,
                    auto_compact_idx,
                },
            );
        }
    }

    /// A rebuilt engine starts every rule with nothing seen, so a built-in
    /// rule that was ALREADY running on this tab would fire again on a
    /// sentinel still on screen: turning auto-compact on would clear a Worker
    /// whose old `[task-done]` is visible, and an edited instructions file
    /// would compact it twice. Each built-in the previous engine also carried
    /// therefore starts from the tab's last scanned text. A built-in that is
    /// newly attached is left alone, as it always was.
    fn carry_built_in_baselines(
        &self,
        tab: &TabId,
        engine: &mut WatchEngine,
        auto_clear_idx: Option<usize>,
        auto_compact_idx: Option<usize>,
    ) {
        let (Some(previous), Some(snapshot)) = (
            self.watch.attached.get(tab),
            self.watch.last_snapshot.get(tab),
        ) else {
            return;
        };
        if previous.auto_clear_idx.is_some() && auto_clear_idx.is_some() {
            engine.rebaseline_kind_keyed(
                &snapshot.text,
                snapshot.key,
                WatchRuleKind::BuiltInAutoClear,
            );
        }
        if previous.auto_compact_idx.is_some() && auto_compact_idx.is_some() {
            engine.rebaseline_kind_keyed(
                &snapshot.text,
                snapshot.key,
                WatchRuleKind::BuiltInAutoCompact,
            );
        }
    }

    /// Drive every live tab's watch rules one tick and return the status lines
    /// to show. Call once per tick from exactly one surface.
    pub fn tick_watch_rules(&mut self) -> Vec<StatusUpdate> {
        let mut statuses = Vec::new();
        // Phase 2 of two-phase delivery first, so a submit key deferred last
        // tick lands before anything new is typed.
        self.flush_pending_watch_enters(Instant::now());
        self.sync_watch_engines(&mut statuses);
        if self.watch.attached.is_empty() {
            return statuses;
        }
        let now = Instant::now();
        let tabs = self.watch_tabs_in_scan_order();
        // Rescans are capped per tick so tabs that all became due together
        // (they start, and so keep being rescanned, in step) are spread over
        // the next few ticks instead of all landing in one. The order rotates
        // past the last tab rescanned, so a tab skipped for budget goes first
        // next tick and every changed tab is rescanned within a few ticks of
        // falling due.
        let mut budget = watch_rescans_per_tick(tabs.len());
        for tab in tabs {
            let typed_recently = self
                .pty_input
                .get(tab.as_str())
                .is_some_and(|at| now.duration_since(*at) < WATCH_TYPING_QUIET);
            if typed_recently {
                continue;
            }
            // An unchanged terminal reuses the text its rules last ran on:
            // rescanning a grid that has not moved is pure cost, and with
            // dozens of tabs it ran on every UI tick. A changed one is rescanned
            // at most every WATCH_RESCAN_INTERVAL.
            let cached = self.watch.last_snapshot.get(&tab);
            let seen = cached.map(|c| c.generation);
            let recently_scanned =
                cached.is_some_and(|c| now.duration_since(c.scanned_at) < WATCH_RESCAN_INTERVAL);
            let Some(client) = self.providers.get(tab.as_ref_id()) else {
                continue;
            };
            let rescan = if recently_scanned || budget == 0 {
                None
            } else {
                client.scan_recent_lines_if_changed(WATCH_SCAN_ROWS, seen)
            };
            let (snapshot, key) = match rescan {
                Some((text, generation)) => {
                    budget -= 1;
                    self.watch.rescan_cursor = Some(tab.clone());
                    #[cfg(test)]
                    {
                        self.watch.rescans += 1;
                    }
                    let text: std::sync::Arc<str> = text.into();
                    let key = SnapshotKey::of(&text);
                    self.watch.last_snapshot.insert(
                        tab.clone(),
                        WatchSnapshot {
                            generation,
                            scanned_at: now,
                            text: text.clone(),
                            key,
                        },
                    );
                    (text, key)
                }
                None => match self.watch.last_snapshot.get(&tab) {
                    Some(c) => (c.text.clone(), c.key),
                    None => continue,
                },
            };
            let snapshot: &str = &snapshot;
            if let Some(until) = self.watch.suppress_until.get(&tab).copied() {
                if now < until {
                    continue;
                }
                self.watch.suppress_until.remove(&tab);
                if let Some(attached) = self.watch.attached.get_mut(&tab) {
                    attached.engine.rebaseline_keyed(snapshot, key);
                }
            }
            let session_id = self
                .owning_session_for_tab(tab.as_str())
                .unwrap_or_default();
            // The AMQ guard reads the agent's mailbox directories, which can
            // hold tens of thousands of files. Ask it only when the answer can
            // matter: a fresh `[task-done]` or `[compact]` the rebaseline below
            // would absorb. Asking every tick for every Worker pinned the UI
            // thread.
            let fresh_task_done = self.watch.attached.get_mut(&tab).is_some_and(|a| {
                a.auto_clear_idx.is_some()
                    && a.engine.kind_has_fresh_match_keyed(
                        snapshot,
                        key,
                        WatchRuleKind::BuiltInAutoClear,
                    )
            });
            let hold_auto_clear =
                fresh_task_done && self.watch_auto_clear_suppressed(tab.as_ref_id(), &session_id);
            let fresh_compact = self.watch.attached.get_mut(&tab).is_some_and(|a| {
                a.auto_compact_idx.is_some()
                    && a.engine.kind_has_fresh_match_keyed(
                        snapshot,
                        key,
                        WatchRuleKind::BuiltInAutoCompact,
                    )
            });
            let hold_auto_compact =
                fresh_compact && self.watch_auto_compact_suppressed(tab.as_ref_id(), &session_id);
            let (effects, built_in_texts) = match self.watch.attached.get_mut(&tab) {
                Some(attached) => {
                    if hold_auto_clear {
                        attached.engine.rebaseline_kind_keyed(
                            snapshot,
                            key,
                            WatchRuleKind::BuiltInAutoClear,
                        );
                    }
                    if hold_auto_compact {
                        attached.engine.rebaseline_kind_keyed(
                            snapshot,
                            key,
                            WatchRuleKind::BuiltInAutoCompact,
                        );
                    }
                    let built_in_texts: Vec<String> = [attached.auto_clear_idx, attached.auto_compact_idx]
                        .into_iter()
                        .flatten()
                        .filter_map(|idx| attached.rules.get(idx))
                        .map(|rule| rule.action.text().to_string())
                        .collect();
                    (attached.engine.observe_keyed(snapshot, key, now), built_in_texts)
                }
                None => continue,
            };
            self.apply_watch_effects(&tab, effects, &built_in_texts, now, &mut statuses);
        }
        statuses
    }

    /// Carry out one tab's effects for this tick. A built-in rule resets the
    /// agent's context, so once one has typed its command the tab's rules
    /// pause for [`WATCH_SUPPRESS_AFTER_INJECT`] and then rebaseline: the
    /// reply that carried its sentinel may carry the other built-in's too, or
    /// echo after the reset, and must not fire a second reset. For the same
    /// reason a second built-in effect in the same tick is dropped; the first
    /// to fire (rule order: auto-clear, then auto-compact) wins.
    fn apply_watch_effects(
        &mut self,
        tab: &TabId,
        effects: Vec<WatchEffect>,
        built_in_texts: &[String],
        now: Instant,
        statuses: &mut Vec<StatusUpdate>,
    ) {
        let mut reset_typed = false;
        for effect in effects {
            let built_in = matches!(
                &effect,
                WatchEffect::SendText { text, .. } if built_in_texts.contains(text)
            );
            if built_in && reset_typed {
                crate::logger::info(&format!(
                    "[watch] tab {tab}: a second built-in reset in one tick was dropped"
                ));
                continue;
            }
            self.apply_watch_effect(tab, effect, now, statuses);
            if built_in {
                reset_typed = true;
                self.suppress_watch_rules(tab.as_ref_id(), now + WATCH_SUPPRESS_AFTER_INJECT);
            }
        }
    }

    /// Attached tabs sorted by id and rotated to start just after the tab
    /// the last capped rescan reached, so the per-tick rescan budget goes
    /// round-robin.
    fn watch_tabs_in_scan_order(&self) -> Vec<TabId> {
        let mut tabs: Vec<TabId> = self.watch.attached.keys().cloned().collect();
        tabs.sort_unstable_by(|a, b| a.as_str().cmp(b.as_str()));
        if let Some(cursor) = &self.watch.rescan_cursor {
            let start = tabs.partition_point(|t| t.as_str() <= cursor.as_str());
            // The cursor need not still be attached: rotation only needs its
            // position in the sorted order.
            let start = start % tabs.len().max(1);
            tabs.rotate_left(start);
        }
        tabs
    }

    fn apply_watch_effect(
        &mut self,
        tab: &TabId,
        effect: WatchEffect,
        now: Instant,
        statuses: &mut Vec<StatusUpdate>,
    ) {
        match effect {
            WatchEffect::SendText { text, append_enter } => {
                // Phase 1: the body only. The submit key waits for
                // `flush_pending_watch_enters` so an Ink reader sees it as a
                // separate keystroke.
                let provider = self.watch_provider_for_tab(tab.as_ref_id());
                let payload = inject_body_bytes_for_provider(&text, provider.as_ref());
                let Some(client) = self.providers.get(tab.as_ref_id()) else {
                    return;
                };
                if client.write_bytes(&payload).is_err() {
                    return;
                }
                if append_enter {
                    self.watch.pending_enters.insert(tab.clone(), now);
                }
            }
            WatchEffect::StatusInfo(msg) => statuses.push(StatusUpdate::info(msg)),
            WatchEffect::StatusWarning(msg) => statuses.push(StatusUpdate::warning(msg)),
        }
    }

    fn watch_provider_for_tab(&self, tab: &TabIdRef) -> Option<crate::model::ProviderKind> {
        let session_id = self.owning_session_for_tab(tab.as_str())?;
        let session = self.session_by_id(&session_id)?;
        Some(self.tab_running_provider(session, tab))
    }

    /// Phase 2 of two-phase delivery: send the submit key to every tab whose
    /// body has waited at least the phase delay. A tab whose PTY went away
    /// drops its deferred Enter rather than retrying it later, when it could
    /// submit whatever the user has typed since.
    fn flush_pending_watch_enters(&mut self, now: Instant) {
        if self.watch.pending_enters.is_empty() {
            return;
        }
        let delay = effective_enter_phase_delay(MIN_ENTER_PHASE_DELAY_MS);
        let due: Vec<TabId> = self
            .watch
            .pending_enters
            .iter()
            .filter(|(_, typed_at)| now.duration_since(**typed_at) >= delay)
            .map(|(tab, _)| tab.clone())
            .collect();
        for tab in due {
            self.watch.pending_enters.remove(&tab);
            let provider = self.watch_provider_for_tab(tab.as_ref_id());
            let key = submit_key_bytes_for_provider(provider.as_ref());
            if let Some(client) = self.providers.get(tab.as_ref_id()) {
                let _ = client.write_bytes(key);
            }
        }
    }

    /// Every loaded rule on every live tab, ordered by session then rule.
    pub fn watch_rule_rows(&self) -> Vec<WatchRuleRow> {
        let mut rows = Vec::new();
        for (tab, attached) in &self.watch.attached {
            let session_id = self
                .owning_session_for_tab(tab.as_str())
                .unwrap_or_default();
            for snapshot in attached.engine.rules_snapshot() {
                rows.push(WatchRuleRow {
                    tab_id: tab.clone(),
                    session_id: session_id.clone(),
                    built_in: Some(snapshot.idx) == attached.auto_clear_idx
                        || Some(snapshot.idx) == attached.auto_compact_idx,
                    snapshot,
                });
            }
        }
        rows.sort_by(|a, b| {
            (a.session_id.as_str(), a.tab_id.as_str(), a.snapshot.idx).cmp(&(
                b.session_id.as_str(),
                b.tab_id.as_str(),
                b.snapshot.idx,
            ))
        });
        rows
    }

    /// Disarm an armed rule or re-arm a disarmed one on a live tab. Returns
    /// the status line to show, or `None` when the tab or rule is gone.
    ///
    /// The new arm state is persisted into the session's `watch_rule_arm`,
    /// so a manual disarm survives restart (and the next sync, which rebuilds
    /// from the persisted overrides, agrees with what the user chose).
    pub fn toggle_watch_rule(&mut self, tab: &TabIdRef, idx: usize) -> Option<StatusUpdate> {
        let attached = self.watch.attached.get_mut(tab)?;
        if Some(idx) == attached.auto_clear_idx {
            return Some(StatusUpdate::info(
                "The auto-clear rule follows the session's Worker settings; change it there.",
            ));
        }
        if Some(idx) == attached.auto_compact_idx {
            return Some(StatusUpdate::info(
                "The auto-compact rule follows the session's Worker settings; change it there.",
            ));
        }
        let snapshot = attached.engine.rules_snapshot().into_iter().nth(idx)?;
        let disarmed = matches!(snapshot.state, crate::watch::RuleStateKind::Disarmed);
        let verb = if disarmed {
            attached.engine.rearm(idx);
            "re-armed"
        } else {
            attached.engine.disarm(idx);
            "disarmed"
        };
        if let Some(session_id) = self.owning_session_for_tab(tab.as_str()) {
            let mut settings = self.session_settings_or_default(&session_id);
            settings.watch_rule_arm.insert(idx, disarmed);
            if let Err(err) = self.persist_session_settings_only(&session_id, settings) {
                // The live engine keeps the toggle; its recorded overrides stay
                // matched to the (unchanged) saved settings, so the next sync
                // does not rebuild it and the toggle lasts for this run.
                return Some(StatusUpdate::warning(format!(
                    "Watch rule \"{}\" {verb} for this run, but saving it failed: {err}",
                    snapshot.label
                )));
            }
            // Saved: record the new overrides so the next sync sees the live
            // engine already matches the settings and keeps it.
            let saved = self.watch_session_settings(&session_id).arm_overrides;
            if let Some(attached) = self.watch.attached.get_mut(tab) {
                attached.arm_overrides = saved;
            }
        }
        Some(StatusUpdate::info(format!(
            "Watch rule \"{}\" {verb}.",
            snapshot.label
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use super::*;
    use crate::engine::test_support::{sample_session, test_engine};
    use crate::pty::PtyClient;
    use crate::watch::{WatchAction, WatchBackoff, WatchBudget};

    /// A rule that fires on the very next tick after its pattern appears.
    fn instant_rule(pattern: &str, text: &str) -> WatchRule {
        WatchRule {
            pattern: pattern.to_string(),
            label: "retry".to_string(),
            action: WatchAction::SendText {
                text: text.to_string(),
                append_enter: true,
            },
            backoff: WatchBackoff {
                initial_ms: 0,
                max_ms: 0,
                multiplier: 1.0,
                jitter_ms: 0,
            },
            budget: WatchBudget { max_attempts: 3 },
            cooldown_ms: 60_000,
            ..Default::default()
        }
    }

    /// A PTY child that prints `banner`, switches its terminal to raw mode, and
    /// records every byte typed at it, unechoed, into `log`. Lets a test see
    /// exactly what yaran typed and in how many writes.
    ///
    /// `stty raw` has to finish before anything is typed: in cooked mode the
    /// line discipline echoes and line-buffers the input, so a pasted body
    /// without a newline never reaches `cat` and the log stays empty. The
    /// child therefore creates `<log>.ready` once raw mode is in effect, and
    /// [`wait_until_raw`] waits for that file rather than guessing with a
    /// sleep, which under a loaded full-suite run was sometimes too short.
    fn recording_pty(banner: &str, log: &std::path::Path) -> PtyClient {
        let script = format!(
            "printf '%s\\n' '{banner}'; stty raw -echo; : > '{}.ready'; exec cat > '{}'",
            log.display(),
            log.display()
        );
        PtyClient::spawn(
            "sh",
            &["-c".to_string(), script],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn recording pty")
    }

    fn wait_for(mut cond: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        cond()
    }

    /// Wait until a [`recording_pty`] child has put its terminal in raw mode.
    /// `exec cat` follows the marker within one shell step, and bytes typed in
    /// that gap wait in the PTY's (now raw) input queue for `cat` to read.
    fn wait_until_raw(log: &std::path::Path) {
        let ready = log.with_extension("log.ready");
        assert!(
            wait_for(|| ready.exists()),
            "the recording child never reached raw mode ({})",
            ready.display()
        );
    }

    fn read_log(path: &std::path::Path) -> Vec<u8> {
        std::fs::read(path).unwrap_or_default()
    }

    /// An engine with one claude agent whose slot tab runs `client`, and
    /// `rules` configured for claude.
    fn engine_with_tab(
        client: PtyClient,
        rules: Vec<WatchRule>,
    ) -> (Engine, crate::test_scratch::ScratchDir) {
        let (mut engine, tmp) = test_engine();
        engine.sessions.push(sample_session("s1", "p1", "feature"));
        let mut claude = crate::config::ProviderCommandConfig {
            command: "claude".to_string(),
            ..Default::default()
        };
        claude.watch = rules;
        engine
            .config
            .providers
            .commands
            .insert("claude".to_string(), claude);
        engine.providers.insert(TabId::new("s1-slot"), client);
        (engine, tmp)
    }

    fn log_path(tmp: &crate::test_scratch::ScratchDir) -> PathBuf {
        tmp.path().join("typed.log")
    }

    #[test]
    fn a_matching_rule_types_the_body_then_submits_it_in_a_later_write() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let log = log_path(&tmp);
        let client = recording_pty("API Error: rate limited", &log);
        let (mut engine, _guard) = engine_with_tab(
            client,
            vec![instant_rule("rate limited", "please continue")],
        );
        assert!(wait_for(|| engine.providers[TabIdRef::new("s1-slot")]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("rate limited")));
        wait_until_raw(&log);

        // Tick 1 notices the match and schedules; tick 2 fires the body.
        let first = engine.tick_watch_rules();
        assert!(first.is_empty(), "{first:?}");
        let fired = engine.tick_watch_rules();
        assert!(
            fired
                .iter()
                .any(|s| s.message.contains("fired (attempt 1/3)")),
            "{fired:?}"
        );
        let body = b"\x1b[200~please continue\x1b[201~".to_vec();
        assert!(wait_for(|| read_log(&log) == body), "{:?}", read_log(&log));

        // The submit key is held back for the phase delay...
        engine.tick_watch_rules();
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(read_log(&log), body, "Enter must not ride with the body");
        // ...then sent on its own.
        std::thread::sleep(Duration::from_millis(MIN_ENTER_PHASE_DELAY_MS));
        engine.tick_watch_rules();
        let mut submitted = body.clone();
        submitted.push(b'\r');
        assert!(
            wait_for(|| read_log(&log) == submitted),
            "{:?}",
            read_log(&log)
        );
        assert!(engine.watch.pending_enters.is_empty());
    }

    #[test]
    fn a_tab_the_user_just_typed_into_is_left_alone() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let log = log_path(&tmp);
        let client = recording_pty("rate limited", &log);
        let (mut engine, _guard) =
            engine_with_tab(client, vec![instant_rule("rate limited", "go")]);
        assert!(wait_for(|| engine.providers[TabIdRef::new("s1-slot")]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("rate limited")));
        // Raw mode first, or an empty log could mean "nothing got through"
        // rather than "nothing was typed".
        wait_until_raw(&log);
        engine.note_pty_input("s1-slot");
        for _ in 0..3 {
            assert!(engine.tick_watch_rules().is_empty());
        }
        std::thread::sleep(Duration::from_millis(300));
        assert!(read_log(&log).is_empty(), "{:?}", read_log(&log));
        // The rule is still waiting, not spent.
        let rows = engine.watch_rule_rows();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].snapshot.attempts_made, 0);
    }

    #[test]
    fn no_rules_means_no_engine_and_teardown_forgets_the_tab() {
        let client = PtyClient::spawn("cat", &[], &std::env::temp_dir(), 24, 80, 100).expect("cat");
        let (mut engine, _guard) = engine_with_tab(client, Vec::new());
        engine.tick_watch_rules();
        assert!(engine.watch.attached.is_empty(), "no rules, no engine");

        engine.config.providers.commands["claude"].watch = vec![instant_rule("x", "y")];
        engine.tick_watch_rules();
        assert!(engine.watch.attached.contains_key(TabIdRef::new("s1-slot")));
        engine
            .watch
            .pending_enters
            .insert(TabId::new("s1-slot"), Instant::now());

        engine.clear_tab_runtime(TabIdRef::new("s1-slot"));
        assert!(engine.watch.attached.is_empty());
        assert!(engine.watch.pending_enters.is_empty());
    }

    #[test]
    fn an_unchanged_config_keeps_the_engine_and_a_changed_one_rebuilds_it() {
        let client = PtyClient::spawn("cat", &[], &std::env::temp_dir(), 24, 80, 100).expect("cat");
        let (mut engine, _guard) = engine_with_tab(client, vec![instant_rule("x", "y")]);
        engine.tick_watch_rules();
        let tab = TabIdRef::new("s1-slot");
        engine.toggle_watch_rule(tab, 0).expect("toggle");
        assert!(engine.watch.attached[tab].engine.is_disarmed(0));

        // Same rules: the manual disarm survives the next tick.
        engine.tick_watch_rules();
        assert!(engine.watch.attached[tab].engine.is_disarmed(0));

        // A config reload that changes the rule rebuilds the engine armed.
        engine.config.providers.commands["claude"].watch = vec![instant_rule("x", "changed")];
        engine.tick_watch_rules();
        assert!(!engine.watch.attached[tab].engine.is_disarmed(0));
    }

    /// A manual disarm is saved into the session's `watch_rule_arm`, so a
    /// fresh process (restart or hot reload) rebuilds the rule disarmed.
    #[test]
    fn a_toggled_rule_is_persisted_into_the_session_settings() {
        let client = PtyClient::spawn("cat", &[], &std::env::temp_dir(), 24, 80, 100).expect("cat");
        let (mut engine, _guard) = engine_with_tab(client, vec![instant_rule("x", "y")]);
        let session = engine.sessions[0].clone();
        engine.session_store.create_session(&session).unwrap();
        engine.tick_watch_rules();
        let tab = TabIdRef::new("s1-slot");
        engine.toggle_watch_rule(tab, 0).expect("toggle");
        assert_eq!(
            engine
                .session_settings("s1")
                .map(|s| s.watch_rule_arm.get(&0).copied()),
            Some(Some(false))
        );
        let stored = engine.session_store.load_session_settings().unwrap();
        assert_eq!(stored["s1"].watch_rule_arm.get(&0), Some(&false));

        // Forget the live engine; a rebuild from settings comes back disarmed.
        engine.watch.attached.clear();
        engine.tick_watch_rules();
        assert!(engine.watch.attached[tab].engine.is_disarmed(0));

        // Re-arming persists too.
        engine.toggle_watch_rule(tab, 0).expect("toggle back");
        let stored = engine.session_store.load_session_settings().unwrap();
        assert_eq!(stored["s1"].watch_rule_arm.get(&0), Some(&true));
    }

    #[test]
    fn an_invalid_rule_is_reported_and_the_rest_still_load() {
        let client = PtyClient::spawn("cat", &[], &std::env::temp_dir(), 24, 80, 100).expect("cat");
        let (mut engine, _guard) = engine_with_tab(
            client,
            vec![instant_rule("(unclosed", "y"), instant_rule("ok", "y")],
        );
        let statuses = engine.tick_watch_rules();
        assert!(
            statuses
                .iter()
                .any(|s| s.message.contains("pattern rejected")),
            "{statuses:?}"
        );
        assert_eq!(engine.watch_rule_rows().len(), 1);
    }

    #[test]
    fn a_suppression_window_holds_the_tab_then_rebaselines_stale_matches() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let log = log_path(&tmp);
        let client = recording_pty("[task-done]", &log);
        let (mut engine, _guard) =
            engine_with_tab(client, vec![instant_rule(r"\[task-done\]", "/clear")]);
        let tab = TabIdRef::new("s1-slot");
        assert!(wait_for(|| engine.providers[tab]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("[task-done]")));
        // Raw mode first, or an empty log could mean "nothing got through"
        // rather than "nothing was typed".
        wait_until_raw(&log);
        engine.suppress_watch_rules(tab, Instant::now() + Duration::from_millis(150));
        engine.tick_watch_rules();
        std::thread::sleep(Duration::from_millis(200));
        // Window over: the sentinel already on screen is absorbed, not fired.
        for _ in 0..3 {
            engine.tick_watch_rules();
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(read_log(&log).is_empty(), "{:?}", read_log(&log));
    }

    /// The auto-clear guard reads the agent's AMQ mailbox directories, which
    /// in real use hold tens of thousands of files. Consulting it on every
    /// tick for every Worker pinned yaran's UI thread in `fstatat`. It must run
    /// only when a fresh `[task-done]` makes its answer matter, and it must
    /// still hold that sentinel when the agent is mid-collaboration.
    #[test]
    fn the_auto_clear_guard_runs_only_for_a_fresh_sentinel() {
        use std::sync::atomic::Ordering::Relaxed;
        let tmp = crate::test_scratch::ScratchDir::new();
        let go = tmp.path().join("go");
        // Quiet until `go` exists, then a finished-task sentinel above a busy
        // footer (the default `esc to interrupt` marker), so the guard holds.
        let script = format!(
            "printf 'working on it\\n'; while [ ! -e '{}' ]; do sleep 0.02; done; \
             printf '[task-done]\\nesc to interrupt\\n'; exec sleep 30",
            go.display()
        );
        let client = PtyClient::spawn(
            "sh",
            &["-c".to_string(), script],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn scripted pty");
        let (mut engine, _guard) = engine_with_tab(client, Vec::new());
        engine.amq.session_settings.insert(
            "s1".to_string(),
            crate::session_settings::SessionSettings {
                mode: crate::session_settings::ContextMode::Worker,
                auto_clear_on_task_done: true,
                ..Default::default()
            },
        );
        let tab = TabIdRef::new("s1-slot");
        let screen = |engine: &Engine| engine.providers[tab].scan_recent_lines(WATCH_SCAN_ROWS);
        assert!(wait_for(|| screen(&engine).contains("working on it")));

        for _ in 0..20 {
            engine.tick_watch_rules();
        }
        let built_in = |engine: &Engine| {
            engine
                .watch_rule_rows()
                .into_iter()
                .find(|row| row.built_in)
                .expect("the built-in auto-clear rule is attached for a Worker")
                .snapshot
                .state
        };
        assert_eq!(built_in(&engine), crate::watch::RuleStateKind::Idle);
        assert_eq!(
            engine.watch.auto_clear_guard_checks.load(Relaxed),
            0,
            "a screen with no sentinel must never consult the guard"
        );

        std::fs::write(&go, b"").unwrap();
        assert!(wait_for(|| screen(&engine).contains("esc to interrupt")));
        // Past the rescan interval, as a real tick loop would be, so the next
        // tick reads the new screen.
        std::thread::sleep(WATCH_RESCAN_INTERVAL);
        for _ in 0..20 {
            engine.tick_watch_rules();
        }
        assert_eq!(
            engine.watch.auto_clear_guard_checks.load(Relaxed),
            1,
            "the guard runs once for the fresh sentinel, which it then absorbs"
        );
        assert_eq!(
            built_in(&engine),
            crate::watch::RuleStateKind::Idle,
            "a held sentinel must not schedule a clear"
        );
    }

    /// A PTY that prints `text` and then idles, for tests that only need a
    /// screen to scan.
    fn printing_pty(text: &str) -> PtyClient {
        let script = format!("printf '%s\\n' '{text}'; exec sleep 30");
        PtyClient::spawn(
            "sh",
            &["-c".to_string(), script],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn printing pty")
    }

    fn worker_settings(
        auto_clear: bool,
        auto_compact: bool,
        compact_path: Option<String>,
    ) -> crate::session_settings::SessionSettings {
        crate::session_settings::SessionSettings {
            mode: crate::session_settings::ContextMode::Worker,
            auto_clear_on_task_done: auto_clear,
            auto_compact_on_compact: auto_compact,
            compact_instructions_path: compact_path,
            ..Default::default()
        }
    }

    fn row_state(engine: &Engine, label: &str) -> Option<crate::watch::RuleStateKind> {
        engine
            .watch_rule_rows()
            .into_iter()
            .find(|row| row.snapshot.label == label)
            .map(|row| row.snapshot.state)
    }

    /// The instructions file is read on a worker thread, so the rule cannot
    /// exist until that read lands; and ticks that run while it is in flight
    /// must not start a second read of the same file.
    #[test]
    fn the_compact_rule_attaches_only_after_its_instructions_file_is_read() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let file = tmp.path().join("compact.txt");
        std::fs::write(&file, "Keep the card.\nDrop old reviews.\n").unwrap();
        let raw_path = file.to_string_lossy().into_owned();
        let (mut engine, _guard) = engine_with_tab(printing_pty("idle"), Vec::new());
        engine.amq.session_settings.insert(
            "s1".to_string(),
            worker_settings(false, true, Some(raw_path.clone())),
        );

        engine.tick_watch_rules();
        engine.tick_watch_rules();
        assert!(
            engine.watch_rule_rows().is_empty(),
            "no rule before the file has been read"
        );
        let loaded = engine
            .worker_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the file is read in the background");
        assert!(
            engine
                .worker_rx
                .recv_timeout(Duration::from_millis(200))
                .is_err(),
            "a read in flight is not started again"
        );
        assert!(matches!(
            &loaded,
            crate::worker::WorkerEvent::CompactInstructionsLoaded { raw_path: p, .. } if *p == raw_path
        ));
        engine.process_worker_event(loaded);

        engine.tick_watch_rules();
        let attached = &engine.watch.attached[TabIdRef::new("s1-slot")];
        let idx = attached.auto_compact_idx.expect("the rule attaches once read");
        assert_eq!(
            attached.rules[idx].action.text(),
            "/compact Keep the card. Drop old reviews."
        );
        assert_eq!(attached.auto_clear_idx, None, "auto-compact alone");
    }

    /// The auto-compact guard reads the same mailbox directories as the
    /// auto-clear guard, so it too runs only for a fresh `[compact]`, and it
    /// holds that sentinel while the agent is busy.
    #[test]
    fn the_auto_compact_guard_runs_only_for_a_fresh_sentinel() {
        use std::sync::atomic::Ordering::Relaxed;
        let tmp = crate::test_scratch::ScratchDir::new();
        let go = tmp.path().join("go");
        let script = format!(
            "printf 'working on it\\n'; while [ ! -e '{}' ]; do sleep 0.02; done; \
             printf '[compact]\\nesc to interrupt\\n'; exec sleep 30",
            go.display()
        );
        let client = PtyClient::spawn(
            "sh",
            &["-c".to_string(), script],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn scripted pty");
        let (mut engine, _guard) = engine_with_tab(client, Vec::new());
        let raw_path = tmp.path().join("compact.txt").to_string_lossy().into_owned();
        engine.amq.session_settings.insert(
            "s1".to_string(),
            worker_settings(false, true, Some(raw_path.clone())),
        );
        engine.process_compact_instructions_loaded(
            raw_path,
            CompactCommandLoad {
                command: "/compact".to_string(),
                warning: None,
            },
        );
        let tab = TabIdRef::new("s1-slot");
        let screen = |engine: &Engine| engine.providers[tab].scan_recent_lines(WATCH_SCAN_ROWS);
        assert!(wait_for(|| screen(&engine).contains("working on it")));

        for _ in 0..20 {
            engine.tick_watch_rules();
        }
        let label = crate::watch::builtin::AUTO_COMPACT_LABEL;
        assert_eq!(
            row_state(&engine, label),
            Some(crate::watch::RuleStateKind::Idle)
        );
        assert_eq!(
            engine.watch.auto_compact_guard_checks.load(Relaxed),
            0,
            "a screen with no sentinel must never consult the guard"
        );

        std::fs::write(&go, b"").unwrap();
        assert!(wait_for(|| screen(&engine).contains("esc to interrupt")));
        std::thread::sleep(WATCH_RESCAN_INTERVAL);
        for _ in 0..20 {
            engine.tick_watch_rules();
        }
        assert_eq!(
            engine.watch.auto_compact_guard_checks.load(Relaxed),
            1,
            "the guard runs once for the fresh sentinel, which it then absorbs"
        );
        assert_eq!(
            engine.watch.auto_clear_guard_checks.load(Relaxed),
            0,
            "[compact] never asks the auto-clear guard"
        );
        assert_eq!(
            row_state(&engine, label),
            Some(crate::watch::RuleStateKind::Idle),
            "a held sentinel must not schedule a compaction"
        );
    }

    /// A reply can carry both sentinels, or echo one after the reset. Once a
    /// built-in has typed its reset, the tab's rules pause, and a second
    /// built-in reset in the same tick is dropped rather than typed on top.
    #[test]
    fn a_built_in_reset_pauses_the_tab_and_drops_a_second_one_in_the_same_tick() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let log = log_path(&tmp);
        let (mut engine, _guard) = engine_with_tab(recording_pty("ready", &log), Vec::new());
        let tab = TabId::new("s1-slot");
        wait_until_raw(&log);
        let send = |text: &str| WatchEffect::SendText {
            text: text.to_string(),
            append_enter: true,
        };
        let built_ins = ["/clear".to_string(), "/compact keep".to_string()];
        let now = Instant::now();
        let mut statuses = Vec::new();
        engine.apply_watch_effects(
            &tab,
            vec![send("/clear"), send("/compact keep")],
            &built_ins,
            now,
            &mut statuses,
        );
        let typed = b"\x1b[200~/clear\x1b[201~".to_vec();
        assert!(wait_for(|| read_log(&log) == typed), "{:?}", read_log(&log));
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(read_log(&log), typed, "the second reset is not typed");
        assert_eq!(
            engine.watch.suppress_until.get(&tab),
            Some(&(now + WATCH_SUPPRESS_AFTER_INJECT)),
            "the tab pauses after a reset"
        );
    }

    #[test]
    fn a_user_rule_effect_does_not_pause_the_tab() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let log = log_path(&tmp);
        let (mut engine, _guard) = engine_with_tab(recording_pty("ready", &log), Vec::new());
        let tab = TabId::new("s1-slot");
        wait_until_raw(&log);
        let mut statuses = Vec::new();
        engine.apply_watch_effects(
            &tab,
            vec![WatchEffect::SendText {
                text: "please continue".to_string(),
                append_enter: true,
            }],
            &["/clear".to_string()],
            Instant::now(),
            &mut statuses,
        );
        assert!(!engine.watch.suppress_until.contains_key(&tab));
    }

    /// Turning auto-compact on rebuilds the tab's engine. A built-in that was
    /// already running there keeps what it had already seen, so an old
    /// `[task-done]` still on screen does not schedule a clear just because
    /// another setting changed.
    #[test]
    fn a_rebuild_does_not_refire_a_running_built_in_on_a_visible_sentinel() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let (mut engine, _guard) = engine_with_tab(printing_pty("[task-done]"), Vec::new());
        let tab = TabIdRef::new("s1-slot");
        assert!(wait_for(|| engine.providers[tab]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("[task-done]")));
        engine
            .amq
            .session_settings
            .insert("s1".to_string(), worker_settings(true, false, None));
        // Absorb the sentinel the way an AMQ inject's pause does.
        engine.suppress_watch_rules(tab, Instant::now() + Duration::from_millis(100));
        engine.tick_watch_rules();
        std::thread::sleep(Duration::from_millis(150));
        engine.tick_watch_rules();
        let clear = crate::watch::builtin::AUTO_CLEAR_LABEL;
        assert_eq!(
            row_state(&engine, clear),
            Some(crate::watch::RuleStateKind::Idle)
        );

        let raw_path = tmp.path().join("compact.txt").to_string_lossy().into_owned();
        engine.amq.session_settings.insert(
            "s1".to_string(),
            worker_settings(true, true, Some(raw_path.clone())),
        );
        engine.process_compact_instructions_loaded(
            raw_path,
            CompactCommandLoad {
                command: "/compact".to_string(),
                warning: None,
            },
        );
        engine.tick_watch_rules();
        assert!(
            engine.watch.attached[tab].auto_compact_idx.is_some(),
            "the engine was rebuilt with the compact rule"
        );
        assert_eq!(
            row_state(&engine, clear),
            Some(crate::watch::RuleStateKind::Idle),
            "the rebuilt auto-clear rule must not schedule a clear"
        );
    }

    /// A screen that changes on every tick (a working agent's spinner) is
    /// rescanned at most once per WATCH_RESCAN_INTERVAL, and a match that
    /// appears is still seen once the interval has passed.
    #[test]
    fn a_busy_screen_is_rescanned_at_most_once_per_interval() {
        let tmp = crate::test_scratch::ScratchDir::new();
        let go = tmp.path().join("go");
        // A spinner redrawn every 20 ms, then, once `go` exists, a real hit.
        let script = format!(
            "i=0; while [ ! -e '{}' ]; do i=$((i+1)); printf '\\rspinner %d' $i; sleep 0.02; done; \
             printf '\\nAPI Error: rate limited\\n'; exec sleep 30",
            go.display()
        );
        let client = PtyClient::spawn(
            "sh",
            &["-c".to_string(), script],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn spinner pty");
        let (mut engine, _guard) = engine_with_tab(
            client,
            vec![instant_rule("rate limited", "please continue")],
        );
        let tab = TabId::new("s1-slot");
        assert!(wait_for(|| engine.providers[tab.as_ref_id()]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("spinner")));

        // Tick for about three intervals while the spinner keeps changing.
        let started = Instant::now();
        let mut scans = 0;
        let mut last_seen = None;
        while started.elapsed() < WATCH_RESCAN_INTERVAL * 3 {
            engine.tick_watch_rules();
            let at = engine.watch.last_snapshot.get(&tab).map(|c| c.scanned_at);
            if at != last_seen {
                scans += 1;
                last_seen = at;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            (2..=4).contains(&scans),
            "a busy screen was rescanned {scans} times in three intervals"
        );

        // A hit that appears is picked up within one interval and fires.
        std::fs::write(&go, b"").unwrap();
        assert!(wait_for(|| engine.providers[tab.as_ref_id()]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("rate limited")));
        let deadline = Instant::now() + WATCH_RESCAN_INTERVAL * 3;
        let mut fired = false;
        while Instant::now() < deadline && !fired {
            fired = engine
                .tick_watch_rules()
                .iter()
                .any(|s| s.message.contains("fired (attempt 1/3)"));
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(fired, "the rule must still fire on a busy screen");
    }

    /// A PTY whose screen changes every 20 ms, forever.
    fn spinner_pty() -> PtyClient {
        PtyClient::spawn(
            "sh",
            &[
                "-c".to_string(),
                "i=0; while :; do i=$((i+1)); printf '\\rspinner %d' $i; sleep 0.02; done"
                    .to_string(),
            ],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn spinner pty")
    }

    /// `n` agents whose slot tabs all run `spawn()` and one claude rule.
    fn engine_with_tabs(
        n: usize,
        spawn: impl Fn() -> PtyClient,
    ) -> (Engine, crate::test_scratch::ScratchDir, Vec<TabId>) {
        let (mut engine, tmp) = engine_with_tab(
            spawn(),
            vec![instant_rule("rate limited", "please continue")],
        );
        let mut tabs = vec![TabId::new("s1-slot")];
        for i in 2..=n {
            let id = format!("s{i}");
            engine
                .sessions
                .push(sample_session(&id, "p1", &format!("f{i}")));
            let tab = TabId::new(format!("{id}-slot"));
            engine.providers.insert(tab.clone(), spawn());
            tabs.push(tab);
        }
        (engine, tmp, tabs)
    }

    #[test]
    fn rescan_budget_scales_with_tab_count() {
        assert_eq!(watch_rescans_per_tick(1), WATCH_MIN_RESCANS_PER_TICK);
        assert_eq!(watch_rescans_per_tick(64), 16);
        assert_eq!(watch_rescans_per_tick(65), 17);
    }

    /// Tabs that all change on every tick fall due together, but no tick
    /// rescans more than the per-tick budget, and round-robin still rescans
    /// every tab within two intervals of its last scan.
    #[test]
    fn busy_tabs_are_spread_across_ticks_and_none_starves() {
        const N: usize = 12;
        let (mut engine, _guard, tabs) = engine_with_tabs(N, spinner_pty);
        for tab in &tabs {
            assert!(wait_for(|| engine.providers[tab.as_ref_id()]
                .scan_recent_lines(WATCH_SCAN_ROWS)
                .contains("spinner")));
        }
        let cap = watch_rescans_per_tick(N);
        assert!(cap < N, "the test needs the cap to bind");

        let started = Instant::now();
        let mut max_gap = Duration::ZERO;
        let mut last: std::collections::HashMap<TabId, Instant> = Default::default();
        while started.elapsed() < WATCH_RESCAN_INTERVAL * 6 {
            let before = engine.watch.rescans;
            engine.tick_watch_rules();
            let did = engine.watch.rescans - before;
            assert!(did <= cap, "one tick rescanned {did} tabs, cap {cap}");
            for tab in &tabs {
                let at = engine.watch.last_snapshot.get(tab).map(|c| c.scanned_at);
                if let Some(at) = at
                    && let Some(prev) = last.insert(tab.clone(), at)
                    && prev != at
                {
                    max_gap = max_gap.max(at - prev);
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(last.len(), N, "every tab was scanned");
        assert!(
            max_gap <= WATCH_RESCAN_INTERVAL * 2,
            "a busy tab waited {max_gap:?} between rescans"
        );
    }

    /// A tab whose grid has not moved is never rescanned, however many ticks
    /// pass after its interval.
    #[test]
    fn an_unchanged_tab_is_not_rescanned() {
        let client = PtyClient::spawn(
            "sh",
            &[
                "-c".to_string(),
                "printf 'idle\\n'; exec sleep 30".to_string(),
            ],
            &std::env::temp_dir(),
            24,
            80,
            100,
        )
        .expect("spawn idle pty");
        let (mut engine, _guard) = engine_with_tab(
            client,
            vec![instant_rule("rate limited", "please continue")],
        );
        let tab = TabId::new("s1-slot");
        assert!(wait_for(|| engine.providers[tab.as_ref_id()]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("idle")));
        std::thread::sleep(Duration::from_millis(100));
        engine.tick_watch_rules();
        let after_first = engine.watch.rescans;
        assert_eq!(after_first, 1);
        std::thread::sleep(WATCH_RESCAN_INTERVAL);
        for _ in 0..50 {
            engine.tick_watch_rules();
        }
        assert_eq!(
            engine.watch.rescans, after_first,
            "an idle tab was rescanned"
        );
    }
}
