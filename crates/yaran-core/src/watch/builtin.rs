//! Built-in watch rules.
//!
//! These rules are constructed in code rather than loaded from
//! `config.toml` so the operator cannot accidentally edit them away.
//! There are two, both used by Worker-mode sessions (the AMQ
//! orchestrator's session settings) and each behind its own opt-in:
//!
//! - auto-clear: a worker that emits the `[task-done]` sentinel at
//!   end-of-task gets its context cleared on the next tick.
//! - auto-compact: a worker that emits the `[compact]` sentinel gets
//!   `/compact` typed, followed by the operator's compaction
//!   instructions, so its context is summarised rather than wiped.
//!
//! The two sentinels are disjoint literals, so `[compact]` can never
//! clear a session and `[task-done]` can never compact one. The
//! session-settings side that decides WHEN to attach a rule belongs to
//! the AMQ orchestrator; this module only builds the rules.
//!
//! Why not config.toml? Two reasons:
//! 1. The rule is feature infrastructure, not user policy. If the
//!    operator removes it the Worker mode loses half its meaning.
//! 2. The clear command (`/clear`, `/new`, …) is provider-specific
//!    and the rule needs to pick it dynamically. Hardcoding it in
//!    config would either bake in claude semantics for every
//!    provider or require operator-driven duplication.

use crate::model::ProviderKind;

use super::rule::{WatchAction, WatchBackoff, WatchBudget, WatchRule, WatchRuleKind};

/// High finite guard for a long-running worker session.
pub const AUTO_CLEAR_MAX_ATTEMPTS: u32 = 10_000;
pub const AUTO_CLEAR_LABEL: &str = "auto-clear after task done";

/// Default sentinel the orchestrator instructs Worker-mode agents to
/// emit at end-of-task. Lowercased, square-bracketed, no whitespace.
/// The yaran-side AMQ drainer also appends a postscript note to wake
/// payloads asking the agent to use this exact token. Exposed as the
/// public token name so the producer and this rule never drift apart.
pub const TASK_DONE_SENTINEL: &str = "[task-done]";

/// Build the built-in auto-clear-on-task-done rule for a session
/// whose provider's "wipe context" command is `clear_command`. The
/// rule can fire repeatedly across tasks, but has a long cooldown so
/// a duplicate sentinel emitted while the clear is still in flight
/// doesn't race-fire.
///
/// Pattern: literal `[task-done]` (regex-escaped to avoid the
/// brackets being interpreted as a character class).
pub fn auto_clear_rule_for(clear_command: &str) -> WatchRule {
    WatchRule {
        // `regex::escape` would also work, but the sentinel is
        // a fixed literal so the manually escaped form is fine and
        // makes the intent obvious to readers.
        pattern: r"\[task-done\]".to_string(),
        label: AUTO_CLEAR_LABEL.to_string(),
        action: WatchAction::SendText {
            text: clear_command.to_string(),
            append_enter: true,
        },
        backoff: WatchBackoff {
            // Short backoff, by the time the sentinel is visible
            // the agent has already finished writing its reply, and
            // we want the clear to land before the operator
            // tab-switches into the session. Two seconds gives the
            // PTY a chance to fully render the final tokens before
            // we type a slash command on top.
            initial_ms: 2_000,
            max_ms: 10_000,
            multiplier: 2.0,
            jitter_ms: 500,
        },
        // Auto-clear must keep working for every AMQ task in a long
        // worker session. The engine's baseline/cooldown logic handles
        // stale visible sentinels, so this budget is only a hard guard
        // against runaway behavior, not a per-task limit.
        budget: WatchBudget {
            max_attempts: AUTO_CLEAR_MAX_ATTEMPTS,
        },
        cooldown_ms: 60_000,
        kind: WatchRuleKind::BuiltInAutoClear,
    }
}

/// High finite guard for a long-running worker session, as for auto-clear.
pub const AUTO_COMPACT_MAX_ATTEMPTS: u32 = 10_000;
pub const AUTO_COMPACT_LABEL: &str = "auto-compact on [compact]";

/// Sentinel a Worker-mode agent emits when its context should be compacted
/// rather than cleared. Lowercased, square-bracketed, no whitespace, like
/// [`TASK_DONE_SENTINEL`], and deliberately not a substring of it.
pub const COMPACT_SENTINEL: &str = "[compact]";

/// The slash command the auto-compact rule types. The instructions, when
/// there are any, follow it on the same line.
pub const COMPACT_COMMAND: &str = "/compact";

/// Build the text the auto-compact rule types: `/compact` followed by the
/// operator's instructions, or a bare `/compact` when there are none.
///
/// The instructions are collapsed onto one line: every run of whitespace,
/// newlines included, becomes a single space. The text is typed into the
/// agent's prompt, where a newline would submit the command early and send
/// the rest of the instructions as a separate message.
pub fn compact_command_text(instructions: Option<&str>) -> String {
    let collapsed = instructions
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    if collapsed.is_empty() {
        COMPACT_COMMAND.to_string()
    } else {
        format!("{COMPACT_COMMAND} {collapsed}")
    }
}

/// Build the built-in auto-compact rule. `command_text` is the full line to
/// type (see [`compact_command_text`]). Same backoff, cooldown and budget
/// shape as auto-clear, for the same reasons: the sentinel is visible only
/// once the reply is written, and a duplicate sentinel seen while the
/// compaction is in flight must not fire a second one.
///
/// Pattern: literal `[compact]` (regex-escaped).
pub fn auto_compact_rule_for(command_text: &str) -> WatchRule {
    WatchRule {
        pattern: r"\[compact\]".to_string(),
        label: AUTO_COMPACT_LABEL.to_string(),
        action: WatchAction::SendText {
            text: command_text.to_string(),
            append_enter: true,
        },
        backoff: WatchBackoff {
            initial_ms: 2_000,
            max_ms: 10_000,
            multiplier: 2.0,
            jitter_ms: 500,
        },
        budget: WatchBudget {
            max_attempts: AUTO_COMPACT_MAX_ATTEMPTS,
        },
        cooldown_ms: 60_000,
        kind: WatchRuleKind::BuiltInAutoCompact,
    }
}

/// The "wipe my context" slash command for each known provider. New
/// providers default to `/clear` because it's the most common
/// convention; if a provider rejects it the rule still fires (the
/// agent prints a help message) but no context is actually cleared,
/// which is the safer failure mode than typing something destructive.
pub fn provider_clear_command(provider: &ProviderKind) -> &'static str {
    match provider.as_str() {
        "claude" => "/clear",
        "codex" => "/new",
        "gemini" => "/clear",
        "opencode" => "/clear",
        _ => "/clear",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_clear_command_known_providers() {
        assert_eq!(
            provider_clear_command(&ProviderKind::new("claude")),
            "/clear"
        );
        assert_eq!(provider_clear_command(&ProviderKind::new("codex")), "/new");
        assert_eq!(
            provider_clear_command(&ProviderKind::new("gemini")),
            "/clear"
        );
        assert_eq!(
            provider_clear_command(&ProviderKind::new("opencode")),
            "/clear"
        );
    }

    #[test]
    fn provider_clear_command_unknown_falls_back_to_clear() {
        assert_eq!(
            provider_clear_command(&ProviderKind::new("future-cli")),
            "/clear"
        );
    }

    #[test]
    fn auto_clear_rule_has_safe_defaults() {
        let r = auto_clear_rule_for("/clear");
        assert_eq!(r.pattern, r"\[task-done\]");
        assert_eq!(r.budget.max_attempts, AUTO_CLEAR_MAX_ATTEMPTS);
        match r.action {
            WatchAction::SendText { text, append_enter } => {
                assert_eq!(text, "/clear");
                assert!(append_enter);
            }
            _ => panic!("expected SendText action"),
        }
    }

    #[test]
    fn auto_clear_rule_pattern_matches_sentinel_literal() {
        // Build a regex with the same builder the engine uses and
        // confirm the escaped pattern matches the literal sentinel
        // but NOT a partial-bracketed substring.
        use regex::RegexBuilder;
        let r = auto_clear_rule_for("/clear");
        let re = RegexBuilder::new(&r.pattern)
            .build()
            .expect("rule pattern compiles");
        assert!(re.is_match("done: [task-done]"));
        assert!(re.is_match("[task-done]"));
        assert!(!re.is_match("task-done")); // no brackets, no match
        assert!(!re.is_match("[TASK-DONE]")); // case-sensitive by default
    }

    #[test]
    fn compact_command_text_without_instructions_is_bare_compact() {
        assert_eq!(compact_command_text(None), "/compact");
        assert_eq!(compact_command_text(Some("")), "/compact");
        assert_eq!(compact_command_text(Some("  \n\t \n")), "/compact");
    }

    #[test]
    fn compact_command_text_appends_instructions_on_one_line() {
        assert_eq!(
            compact_command_text(Some("Keep the open PRs.\nDrop the old reviews.\n")),
            "/compact Keep the open PRs. Drop the old reviews."
        );
        assert_eq!(
            compact_command_text(Some("  keep   the\r\ncard  ")),
            "/compact keep the card"
        );
    }

    #[test]
    fn auto_compact_rule_has_safe_defaults() {
        let r = auto_compact_rule_for("/compact keep the card");
        assert_eq!(r.pattern, r"\[compact\]");
        assert_eq!(r.kind, WatchRuleKind::BuiltInAutoCompact);
        assert_eq!(r.budget.max_attempts, AUTO_COMPACT_MAX_ATTEMPTS);
        match r.action {
            WatchAction::SendText { text, append_enter } => {
                assert_eq!(text, "/compact keep the card");
                assert!(append_enter);
            }
            _ => panic!("expected SendText action"),
        }
    }

    #[test]
    fn the_two_sentinel_patterns_never_match_each_other() {
        use regex::RegexBuilder;
        let compact = RegexBuilder::new(&auto_compact_rule_for("/compact").pattern)
            .build()
            .expect("compact pattern compiles");
        let clear = RegexBuilder::new(&auto_clear_rule_for("/clear").pattern)
            .build()
            .expect("clear pattern compiles");
        assert!(compact.is_match(COMPACT_SENTINEL));
        assert!(!compact.is_match(TASK_DONE_SENTINEL));
        assert!(clear.is_match(TASK_DONE_SENTINEL));
        assert!(!clear.is_match(COMPACT_SENTINEL));
        assert!(!compact.is_match("compact")); // no brackets, no match
    }
}
