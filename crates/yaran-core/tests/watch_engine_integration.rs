//! End-to-end integration test for the watch engine.
//!
//! Spawns `cat` in a real PTY (via `yaran_core::pty::PtyClient`), writes a
//! pattern-matching string into the PTY, scans the resulting visible
//! viewport with `WatchEngine`, and asserts that the engine's
//! `WatchEffect::SendText` payload, when written back through the PTY —
//! shows up in the next scan. This exercises the full Phase 1 surface:
//! regex matching, backoff/cooldown timing, the scan helper on
//! `PtyClient`, and the integration between effects and PTY writes.

use std::thread;
use std::time::{Duration, Instant};

use yaran_core::pty::PtyClient;
use yaran_core::watch::{
    WatchAction, WatchBackoff, WatchBudget, WatchEffect, WatchEngine, WatchRule,
};

/// Poll `cond` until it returns true or `timeout` elapses. Sleeps for
/// `step` between polls. Returns true if the condition held within the
/// budget. Used so the test isn't a flaky fixed-sleep.
fn wait_until<F: FnMut() -> bool>(mut cond: F, timeout: Duration, step: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        thread::sleep(step);
    }
    cond()
}

fn rule_matching(pattern: &str, text: &str) -> WatchRule {
    WatchRule {
        pattern: pattern.to_string(),
        label: "test rule".to_string(),
        action: WatchAction::SendText {
            text: text.to_string(),
            append_enter: true,
        },
        backoff: WatchBackoff {
            // Tight backoff so the test is fast but still exercises the
            // Idle → Pending → fire transition.
            initial_ms: 50,
            max_ms: 1_000,
            multiplier: 2.0,
            jitter_ms: 0,
        },
        budget: WatchBudget { max_attempts: 3 },
        cooldown_ms: 100,
        ..Default::default()
    }
}

#[test]
fn watch_engine_matches_pty_output_and_drives_send_text() {
    // Spawn `cat` in a small PTY. cat echoes everything we write back.
    let cwd = std::env::temp_dir();
    let client = PtyClient::spawn("cat", &[], &cwd, 24, 80, 1_000).expect("spawn cat in PTY");

    // Write a string that matches the watch rule's pattern.
    client
        .write_bytes(b"the agent is rate limited now\r")
        .expect("write trigger to PTY");

    // Wait for cat to echo the line.
    let saw_match = wait_until(
        || client.scan_recent_lines(30).contains("rate limited"),
        Duration::from_secs(2),
        Duration::from_millis(20),
    );
    assert!(
        saw_match,
        "cat should echo trigger string within 2s; actual: {:?}",
        client.scan_recent_lines(30)
    );

    // Build the engine with the throttle-style rule and a fast backoff.
    let (mut engine, errors) = WatchEngine::new(
        "session-cat".to_string(),
        &[rule_matching("rate limited", "please continue")],
    );
    assert!(errors.is_empty(), "rule load errors: {errors:?}");
    assert_eq!(engine.rule_count(), 1);

    // First observe: should detect the match and schedule a fire ~50ms
    // out. No effects yet.
    let snapshot = client.scan_recent_lines(30);
    let effects = engine.observe(&snapshot, Instant::now());
    assert!(
        effects.is_empty(),
        "first observe should only schedule, not fire: {effects:?}"
    );

    // Wait past the backoff window and observe again to fire. Drain a
    // few frames in case the backoff jitter pushes us slightly past the
    // first poll.
    let mut send_text: Option<String> = None;
    let mut status_seen = false;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && send_text.is_none() {
        thread::sleep(Duration::from_millis(40));
        let snapshot = client.scan_recent_lines(30);
        for effect in engine.observe(&snapshot, Instant::now()) {
            match effect {
                WatchEffect::SendText { text, append_enter } => {
                    assert!(append_enter, "rule was configured with append_enter=true");
                    send_text = Some(text);
                }
                WatchEffect::StatusInfo(_) => status_seen = true,
                WatchEffect::StatusWarning(msg) => panic!("unexpected warning: {msg}"),
            }
        }
    }
    let send_text = send_text.expect("engine should have fired SendText within 2s");
    assert_eq!(send_text, "please continue");
    assert!(
        status_seen,
        "engine should have emitted StatusInfo when firing"
    );

    // Apply the SendText effect: write payload + CR to the PTY. cat
    // should echo it back. This proves the full "watch fires → bytes
    // hit the agent" pathway works end to end.
    let mut payload = send_text.into_bytes();
    payload.push(b'\r');
    client.write_bytes(&payload).expect("send retry to PTY");
    let saw_retry = wait_until(
        || client.scan_recent_lines(30).contains("please continue"),
        Duration::from_secs(2),
        Duration::from_millis(20),
    );
    assert!(
        saw_retry,
        "cat should echo the watch-engine payload; actual: {:?}",
        client.scan_recent_lines(30)
    );
}

#[test]
fn watch_engine_no_rules_for_provider_is_noop() {
    // With zero rules, the engine reports rule_count == 0 and observe
    // returns an empty Vec for any snapshot.
    let (mut engine, errors) = WatchEngine::new("noop", &[]);
    assert!(errors.is_empty());
    assert_eq!(engine.rule_count(), 0);

    let effects = engine.observe("rate limited everything is on fire", Instant::now());
    assert!(effects.is_empty(), "no rules ⇒ no effects: {effects:?}");
}

/// the built-in auto-clear-on-task-done rule fires
/// `SendText { text: <provider clear cmd>, append_enter: true }` when
/// it sees the literal `[task-done]` sentinel in the snapshot.
/// End-to-end via a real PTY so we exercise the same `scan_recent_lines`
/// path the App uses at runtime.
#[test]
fn auto_clear_rule_fires_on_task_done_sentinel_through_pty() {
    use yaran_core::model::ProviderKind;
    use yaran_core::watch::builtin::{auto_clear_rule_for, provider_clear_command};

    let cwd = std::env::temp_dir();
    let client = PtyClient::spawn("cat", &[], &cwd, 24, 80, 1_000).expect("spawn cat");

    // Write the sentinel into the PTY; cat echoes it back so the
    // engine sees it via scan_recent_lines.
    client
        .write_bytes(b"finished the task [task-done]\r")
        .expect("write sentinel");

    let saw_sentinel = wait_until(
        || client.scan_recent_lines(30).contains("[task-done]"),
        Duration::from_secs(2),
        Duration::from_millis(20),
    );
    assert!(saw_sentinel, "cat should echo the sentinel within 2s");

    // Build the engine with the built-in rule for claude (which uses
    // `/clear` as its clear command). Tweak the backoff for the test so
    // we don't need to wait the production 2s.
    let provider = ProviderKind::new("claude");
    let mut rule = auto_clear_rule_for(provider_clear_command(&provider));
    rule.backoff.initial_ms = 50;
    rule.backoff.jitter_ms = 0;
    rule.cooldown_ms = 50;
    let (mut engine, errors) = WatchEngine::new("auto-clear-1".to_string(), &[rule]);
    assert!(errors.is_empty(), "load errors: {errors:?}");
    assert_eq!(engine.rule_count(), 1);

    // First observe schedules but does not fire.
    let snap = client.scan_recent_lines(30);
    let effects = engine.observe(&snap, Instant::now());
    assert!(
        effects.is_empty(),
        "first observe should schedule, not fire: {effects:?}"
    );

    // Wait past the backoff and observe again until fired.
    let mut fired_text: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline && fired_text.is_none() {
        thread::sleep(Duration::from_millis(40));
        let snap = client.scan_recent_lines(30);
        for effect in engine.observe(&snap, Instant::now()) {
            if let WatchEffect::SendText { text, append_enter } = effect {
                assert!(append_enter, "auto-clear rule must Enter-submit");
                fired_text = Some(text);
            }
        }
    }
    let text = fired_text.expect("auto-clear rule should have fired SendText within 2s");
    assert_eq!(text, "/clear", "claude provider's clear command is /clear");
}

#[test]
fn auto_clear_rule_fires_for_multiple_completed_tasks() {
    use yaran_core::model::ProviderKind;
    use yaran_core::watch::builtin::{auto_clear_rule_for, provider_clear_command};

    let provider = ProviderKind::new("claude");
    let mut rule = auto_clear_rule_for(provider_clear_command(&provider));
    rule.backoff.initial_ms = 10;
    rule.backoff.multiplier = 1.0;
    rule.backoff.jitter_ms = 0;
    rule.cooldown_ms = 20;

    let (mut engine, errors) = WatchEngine::new("auto-clear-repeat".to_string(), &[rule]);
    assert!(errors.is_empty(), "load errors: {errors:?}");

    let t0 = Instant::now();
    assert!(engine.observe("first task [task-done]", t0).is_empty());
    let effects = engine.observe("first task [task-done]", t0 + Duration::from_millis(15));
    assert!(
        effects.iter().any(|effect| {
            matches!(
                effect,
                WatchEffect::SendText { text, append_enter: true } if text == "/clear"
            )
        }),
        "first task completion should trigger clear: {effects:?}"
    );

    // Simulate the provider clearing the visible transcript before the
    // next task completes. This ratchets the match baseline back to zero.
    assert!(
        engine
            .observe("transcript cleared", t0 + Duration::from_millis(40))
            .is_empty()
    );

    assert!(
        engine
            .observe("second task [task-done]", t0 + Duration::from_millis(50))
            .is_empty()
    );
    let effects = engine.observe("second task [task-done]", t0 + Duration::from_millis(65));
    assert!(
        effects.iter().any(|effect| {
            matches!(
                effect,
                WatchEffect::SendText { text, append_enter: true } if text == "/clear"
            )
        }),
        "second task completion should trigger clear too: {effects:?}"
    );
}

/// codex sessions get `/new` instead of `/clear` and
/// unknown providers fall back to `/clear` (the safe default).
#[test]
fn auto_clear_rule_provider_clear_command_dispatch() {
    use yaran_core::model::ProviderKind;
    use yaran_core::watch::builtin::provider_clear_command;

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
        provider_clear_command(&ProviderKind::new("custom-future")),
        "/clear"
    );
}

/// The two built-in rules with test-speed timing, auto-clear first as the
/// engine attaches them. `compact_text` is the line the compact rule types.
fn built_in_rules(compact_text: &str) -> Vec<WatchRule> {
    use yaran_core::watch::builtin::{auto_clear_rule_for, auto_compact_rule_for};

    [auto_clear_rule_for("/clear"), auto_compact_rule_for(compact_text)]
        .into_iter()
        .map(|mut rule| {
            rule.backoff.initial_ms = 20;
            rule.backoff.multiplier = 1.0;
            rule.backoff.jitter_ms = 0;
            rule.cooldown_ms = 50;
            rule
        })
        .collect()
}

/// Echo `line` through a real `cat` PTY and return the client once the
/// line is visible to `scan_recent_lines`, the path the engine reads.
fn pty_showing(line: &str) -> PtyClient {
    let client = PtyClient::spawn("cat", &[], &std::env::temp_dir(), 24, 80, 1_000)
        .expect("spawn cat in PTY");
    client
        .write_bytes(format!("{line}\r").as_bytes())
        .expect("write line");
    assert!(
        wait_until(
            || client.scan_recent_lines(30).contains(line),
            Duration::from_secs(2),
            Duration::from_millis(20),
        ),
        "cat should echo {line:?} within 2s"
    );
    client
}

/// Observe the PTY until the engine has been idle past every backoff, and
/// return every `SendText` it produced.
fn texts_sent(engine: &mut WatchEngine, client: &PtyClient) -> Vec<String> {
    let mut sent = Vec::new();
    let deadline = Instant::now() + Duration::from_millis(400);
    while Instant::now() < deadline {
        let snap = client.scan_recent_lines(30);
        for effect in engine.observe(&snap, Instant::now()) {
            if let WatchEffect::SendText { text, append_enter } = effect {
                assert!(append_enter, "a built-in reset must Enter-submit");
                sent.push(text);
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    sent
}

/// `[compact]` fires the compact rule, which types `/compact` followed by
/// the instructions file's text on one line, and that text reaches the PTY.
#[test]
fn auto_compact_rule_types_the_instructions_file_through_pty() {
    use yaran_core::watch::builtin::{auto_compact_rule_for, load_compact_command};

    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("compact-instructions.txt");
    std::fs::write(&file, "Keep the open PRs.\nDrop old reviews.\n").expect("write file");
    let load = load_compact_command(&file.to_string_lossy());
    assert_eq!(load.warning, None);

    let client = pty_showing("context is full [compact]");
    let mut rule = auto_compact_rule_for(&load.command);
    rule.backoff.initial_ms = 20;
    rule.backoff.jitter_ms = 0;
    let (mut engine, errors) = WatchEngine::new("auto-compact-1".to_string(), &[rule]);
    assert!(errors.is_empty(), "load errors: {errors:?}");

    let sent = texts_sent(&mut engine, &client);
    assert_eq!(sent, vec!["/compact Keep the open PRs. Drop old reviews.".to_string()]);

    client
        .write_bytes(sent[0].as_bytes())
        .expect("type the compact line");
    assert!(
        wait_until(
            || client
                .scan_recent_lines(30)
                .contains("/compact Keep the open PRs. Drop old reviews."),
            Duration::from_secs(2),
            Duration::from_millis(20),
        ),
        "the typed line should reach the PTY"
    );
}

/// A missing instructions file still compacts: a bare `/compact`.
#[test]
fn auto_compact_rule_types_a_bare_compact_when_the_file_is_missing() {
    use yaran_core::watch::builtin::{auto_compact_rule_for, load_compact_command};

    let dir = tempfile::tempdir().expect("tempdir");
    let load = load_compact_command(&dir.path().join("absent.txt").to_string_lossy());
    assert!(load.warning.is_some(), "the fallback says why");

    let client = pty_showing("done for now [compact]");
    let mut rule = auto_compact_rule_for(&load.command);
    rule.backoff.initial_ms = 20;
    rule.backoff.jitter_ms = 0;
    let (mut engine, _) = WatchEngine::new("auto-compact-bare".to_string(), &[rule]);
    assert_eq!(texts_sent(&mut engine, &client), vec!["/compact".to_string()]);
}

/// `[compact]` on screen never clears a session that has both rules.
#[test]
fn the_compact_sentinel_never_fires_auto_clear_through_pty() {
    let client = pty_showing("context is full [compact]");
    let (mut engine, errors) =
        WatchEngine::new("no-cross-compact".to_string(), &built_in_rules("/compact keep"));
    assert!(errors.is_empty(), "load errors: {errors:?}");
    assert_eq!(
        texts_sent(&mut engine, &client),
        vec!["/compact keep".to_string()]
    );
}

/// `[task-done]` on screen never compacts a session that has both rules.
#[test]
fn the_task_done_sentinel_never_fires_auto_compact_through_pty() {
    let client = pty_showing("finished the task [task-done]");
    let (mut engine, errors) =
        WatchEngine::new("no-cross-task-done".to_string(), &built_in_rules("/compact keep"));
    assert!(errors.is_empty(), "load errors: {errors:?}");
    assert_eq!(texts_sent(&mut engine, &client), vec!["/clear".to_string()]);
}

/// The engine holds a built-in (busy agent, pending AMQ mail) by absorbing
/// its sentinel into the rule's baseline. Holding `[compact]` must keep it
/// from ever firing, and must not absorb a `[task-done]` on the same screen.
#[test]
fn a_held_compact_sentinel_never_fires_and_leaves_auto_clear_armed() {
    use yaran_core::watch::WatchRuleKind;

    let client = pty_showing("[task-done] then [compact]");
    let (mut engine, errors) =
        WatchEngine::new("hold-compact".to_string(), &built_in_rules("/compact keep"));
    assert!(errors.is_empty(), "load errors: {errors:?}");
    engine.rebaseline_kind(
        &client.scan_recent_lines(30),
        WatchRuleKind::BuiltInAutoCompact,
    );
    assert_eq!(texts_sent(&mut engine, &client), vec!["/clear".to_string()]);
}
