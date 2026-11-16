//! The pure per-tick attention decision, shared by the sidebar's attention set and the
//! push-only set behind phone notifications (D12).
//!
//! Both sets run the same function on the same `fired` list with the same `engaged`
//! predicate, so they can only disagree on what `enabled` says.
//!
//! - Pure: no I/O apart from debug logging.
//!
//! <module-headers:begin>
//! Uses:
//! engine/attention_decision.rs
//! ├── engine
//! ├── ids
//! └── logger
//! External: std
//!
//! Used by:
//! engine/attention_decision.rs
//! ├── cloud::push_edges
//! ├── engine
//! └── engine::push_hook
//! <module-headers:end>

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use super::{AGENT_INPUT_SUPPRESSION_WINDOW, ATTENTION_ENGAGED_WINDOW};
use crate::ids::{TabId, TabIdRef};

/// Whether the user is currently "engaged" with a tab and so should not be
/// nagged about it: they either looked at it within [`ATTENTION_ENGAGED_WINDOW`]
/// (`viewed`) or typed into it within [`AGENT_INPUT_SUPPRESSION_WINDOW`]
/// (`typed`). A free function so [`super::Engine::poll_agent_signals`] can call it while
/// holding a disjoint mutable borrow of `needs_attention`, and so the windowing
/// is unit-testable without a live PTY.
pub(crate) fn attention_engaged(
    viewed: &HashMap<TabId, Instant>,
    // `pty_input` spans the whole PTY keyspace (tabs AND companion terminals),
    // so it stays string-keyed and is probed with the tab id's raw string.
    typed: &HashMap<String, Instant>,
    tab_id: &TabIdRef,
    now: Instant,
) -> bool {
    viewed
        .get(tab_id)
        .is_some_and(|t| now.duration_since(*t) < ATTENTION_ENGAGED_WINDOW)
        || typed
            .get(tab_id.as_str())
            .is_some_and(|t| now.duration_since(*t) < AGENT_INPUT_SUPPRESSION_WINDOW)
}

/// The pure per-tick attention decision behind [`super::Engine::poll_agent_signals`].
/// Given the tabs whose attention signal fired this tick (`fired`, already gated by the
/// `attention_on_bell` preference at drain time), whether the feature is enabled,
/// and an `engaged` predicate, it updates `needs_attention` in place:
///
/// - Feature off: clear everything (never accumulate; drop anything left over
///   from before a runtime toggle).
/// - Otherwise: clear the flag on any tab the user is now engaged with, then set
///   it for each freshly-fired tab the user is NOT engaged with. Each outcome is
///   logged at debug level so the whole pipeline is diagnosable from `yaran.log`
///   without adding default-level noise.
pub(crate) fn apply_attention_decision(
    needs_attention: &mut HashSet<TabId>,
    fired: &[TabId],
    enabled: bool,
    engaged: impl Fn(&TabIdRef) -> bool,
) {
    if !enabled {
        needs_attention.clear();
        return;
    }
    // Looking at (or typing into) a tab clears its flag.
    needs_attention.retain(|tab| !engaged(tab));
    // A newly-fired signal sets the flag unless the user is engaged with it.
    for tab in fired {
        if engaged(tab) {
            crate::logger::debug(&format!(
                "attention signal for tab {tab} suppressed: user is engaged"
            ));
        } else {
            crate::logger::debug(&format!("attention flagged for tab {tab}"));
            needs_attention.insert(tab.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn attention_engaged_covers_viewing_and_typing() {
        let now = Instant::now();
        let mut viewed = HashMap::new();
        let mut typed = HashMap::new();

        // Nothing recorded → not engaged.
        assert!(!attention_engaged(
            &viewed,
            &typed,
            TabIdRef::new("s1"),
            now
        ));

        // Fresh view → engaged.
        viewed.insert(TabId::new("s1"), now);
        assert!(attention_engaged(&viewed, &typed, TabIdRef::new("s1"), now));

        // Stale view → not engaged.
        viewed.insert(
            TabId::new("s1"),
            now - (ATTENTION_ENGAGED_WINDOW + Duration::from_millis(50)),
        );
        assert!(!attention_engaged(
            &viewed,
            &typed,
            TabIdRef::new("s1"),
            now
        ));

        // Fresh typing alone → engaged.
        typed.insert("s1".to_string(), now);
        assert!(attention_engaged(&viewed, &typed, TabIdRef::new("s1"), now));

        // Stale typing → not engaged.
        typed.insert(
            "s1".to_string(),
            now - (AGENT_INPUT_SUPPRESSION_WINDOW + Duration::from_millis(50)),
        );
        assert!(!attention_engaged(
            &viewed,
            &typed,
            TabIdRef::new("s1"),
            now
        ));
    }

    #[test]
    fn apply_attention_decision_sets_flag_when_not_engaged() {
        let mut set = HashSet::new();
        apply_attention_decision(&mut set, &[TabId::new("s1")], true, |_| false);
        assert!(
            set.contains(TabIdRef::new("s1")),
            "a fired, unengaged tab must be flagged"
        );
    }

    #[test]
    fn apply_attention_decision_suppresses_and_clears_when_engaged() {
        let mut set = HashSet::new();
        set.insert(TabId::new("s1"));
        // Engaged: the fired signal is suppressed AND the existing flag is cleared.
        apply_attention_decision(&mut set, &[TabId::new("s1")], true, |_| true);
        assert!(
            !set.contains(TabIdRef::new("s1")),
            "engagement must both suppress the new signal and clear the old flag"
        );
    }

    #[test]
    fn apply_attention_decision_clears_stale_flag_without_a_new_signal() {
        let mut set = HashSet::new();
        set.insert(TabId::new("s1"));
        // No new signal this tick, but the user is now engaged → clear.
        apply_attention_decision(&mut set, &[], true, |tab| tab.as_str() == "s1");
        assert!(!set.contains(TabIdRef::new("s1")));
    }

    #[test]
    fn apply_attention_decision_retains_flag_while_unengaged() {
        let mut set = HashSet::new();
        set.insert(TabId::new("s1"));
        apply_attention_decision(&mut set, &[], true, |_| false);
        assert!(
            set.contains(TabIdRef::new("s1")),
            "an unviewed flag must persist across ticks"
        );
    }

    #[test]
    fn apply_attention_decision_disabled_clears_everything() {
        let mut set = HashSet::new();
        set.insert(TabId::new("s1"));
        apply_attention_decision(&mut set, &[TabId::new("s2")], false, |_| false);
        assert!(set.is_empty(), "the feature being off must drop every flag");
    }
}
