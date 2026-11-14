//! The push-only attention set (D12): rising and falling edges for phone notifications.
//!
//! Runs the sidebar's own decision (`apply_attention_decision`) on a second set, with the
//! same `fired` list and `engaged` predicate but `enabled` = "push is on", so turning the
//! sidebar indicator off never silences the phone. Diffing once per tick (rather than
//! hooking `insert`) catches every removal path: a view lands through `engaged`, and a tab
//! whose provider is gone (exit, kill, detach, close, delete) is dropped by `live`.
//!
//! - Pure and engine-free; the engine calls `observe` once per tick.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/push_edges.rs
//! ├── engine::attention_decision
//! └── ids
//! External: std
//!
//! Used by:
//! cloud/push_edges.rs
//! ├── cloud
//! └── engine::push_hook
//! <module-headers:end>

use std::collections::HashSet;

use crate::engine::attention_decision::apply_attention_decision;
use crate::ids::{TabId, TabIdRef};

/// Which way a tab's push attention moved this tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    Raised,
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub tab: TabId,
    pub kind: EdgeKind,
}

/// The shadow set and nothing else.
#[derive(Debug, Default)]
pub struct PushEdges {
    shadow: HashSet<TabId>,
}

impl PushEdges {
    /// One tick: apply the decision, drop tabs that are no longer live, return the diff
    /// (sorted by tab id so the order is deterministic).
    pub fn observe(
        &mut self,
        fired: &[TabId],
        enabled: bool,
        engaged: impl Fn(&TabIdRef) -> bool,
        live: impl Fn(&TabIdRef) -> bool,
    ) -> Vec<Edge> {
        let before = self.shadow.clone();
        apply_attention_decision(&mut self.shadow, fired, enabled, engaged);
        self.shadow.retain(|tab| live(tab));
        let raised = self.shadow.difference(&before).map(|tab| Edge {
            tab: tab.clone(),
            kind: EdgeKind::Raised,
        });
        let cleared = before.difference(&self.shadow).map(|tab| Edge {
            tab: tab.clone(),
            kind: EdgeKind::Cleared,
        });
        let mut edges: Vec<Edge> = raised.chain(cleared).collect();
        edges.sort_by(|a, b| a.tab.as_str().cmp(b.tab.as_str()));
        edges
    }

    /// Whether the push set currently holds this tab.
    pub fn contains(&self, tab: &TabIdRef) -> bool {
        self.shadow.contains(tab)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: &str) -> TabId {
        TabId::new(id)
    }

    fn raised(id: &str) -> Edge {
        Edge {
            tab: t(id),
            kind: EdgeKind::Raised,
        }
    }

    fn cleared(id: &str) -> Edge {
        Edge {
            tab: t(id),
            kind: EdgeKind::Cleared,
        }
    }

    const LIVE: fn(&TabIdRef) -> bool = |_| true;
    const NOT_ENGAGED: fn(&TabIdRef) -> bool = |_| false;

    #[test]
    fn push_edges_raise_once_per_rising_edge() {
        let mut e = PushEdges::default();
        assert_eq!(
            e.observe(&[t("a")], true, NOT_ENGAGED, LIVE),
            vec![raised("a")]
        );
        // Firing again while flagged is not an edge.
        assert!(e.observe(&[t("a")], true, NOT_ENGAGED, LIVE).is_empty());
        assert!(e.observe(&[], true, NOT_ENGAGED, LIVE).is_empty());
    }

    #[test]
    fn push_edges_engaged_suppresses_the_raise() {
        let mut e = PushEdges::default();
        assert!(e.observe(&[t("a")], true, |_| true, LIVE).is_empty());
    }

    #[test]
    fn push_edges_viewed_then_next_tick_clears() {
        let mut e = PushEdges::default();
        e.observe(&[t("a")], true, NOT_ENGAGED, LIVE);
        assert_eq!(
            e.observe(&[], true, |tab| tab.as_str() == "a", LIVE),
            vec![cleared("a")]
        );
    }

    #[test]
    fn push_edges_provider_gone_clears() {
        let mut e = PushEdges::default();
        e.observe(&[t("a"), t("b")], true, NOT_ENGAGED, LIVE);
        assert_eq!(
            e.observe(&[], true, NOT_ENGAGED, |tab| tab.as_str() != "a"),
            vec![cleared("a")]
        );
        assert!(e.contains(TabIdRef::new("b")));
    }

    #[test]
    fn push_edges_disabled_clears_everything() {
        let mut e = PushEdges::default();
        e.observe(&[t("a"), t("b")], true, NOT_ENGAGED, LIVE);
        assert_eq!(
            e.observe(&[t("c")], false, NOT_ENGAGED, LIVE),
            vec![cleared("a"), cleared("b")]
        );
    }

    #[test]
    fn push_edges_reraise_after_clear_raises_again() {
        let mut e = PushEdges::default();
        e.observe(&[t("a")], true, NOT_ENGAGED, LIVE);
        e.observe(&[], true, |_| true, LIVE);
        assert_eq!(
            e.observe(&[t("a")], true, NOT_ENGAGED, LIVE),
            vec![raised("a")]
        );
    }

    #[test]
    fn push_edges_match_the_ui_set_on_identical_inputs() {
        // Same inputs, same function: the two sets agree tick for tick.
        let mut e = PushEdges::default();
        let mut ui = HashSet::new();
        let ticks: [&[TabId]; 3] = [&[t("a")], &[t("b")], &[]];
        for (i, fired) in ticks.into_iter().enumerate() {
            let engaged = |tab: &TabIdRef| i == 2 && tab.as_str() == "a";
            e.observe(fired, true, engaged, LIVE);
            apply_attention_decision(&mut ui, fired, true, engaged);
            for tab in ["a", "b"] {
                assert_eq!(
                    e.contains(TabIdRef::new(tab)),
                    ui.contains(TabIdRef::new(tab))
                );
            }
        }
    }
}
