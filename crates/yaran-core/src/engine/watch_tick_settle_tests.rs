//! Tests for the built-in startup settle window: for
//! `WATCH_BUILT_IN_STARTUP_SETTLE` after a tab's PTY is spawned or adopted, a
//! replayed `[task-done]` or `[compact]` never reaches auto-clear or
//! auto-compact, a sentinel printed after it does, and user rules are not held.
//!
//! - Test-only (`#[cfg(test)]` child of `engine::watch_tick`); real PTYs, with
//!   the window crossed on a logical clock rather than by sleeping.

use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::{Duration, Instant};

use super::schedule_tests::engine_with_tabs;
use super::tests::{
    engine_with_tab, instant_rule, printing_pty, row_state, wait_for, worker_settings,
};
use super::*;
use crate::pty::PtyClient;
use crate::session_settings::SessionSettings;
use crate::watch::RuleStateKind;
use crate::watch::builtin::{AUTO_CLEAR_LABEL, AUTO_COMPACT_LABEL};

/// One built-in rule under test: the sentinel it reacts to, the settings
/// that attach it, its row label, and the guard counter a fresh sentinel bumps.
struct BuiltIn {
    sentinel: &'static str,
    label: &'static str,
    settings: fn(&std::path::Path) -> SessionSettings,
    guard: fn(&Engine) -> &AtomicUsize,
}

const AUTO_CLEAR: BuiltIn = BuiltIn {
    sentinel: "[task-done]",
    label: AUTO_CLEAR_LABEL,
    settings: |_| worker_settings(true, false, None),
    guard: |e| &e.watch.auto_clear_guard_checks,
};

const AUTO_COMPACT: BuiltIn = BuiltIn {
    sentinel: "[compact]",
    label: AUTO_COMPACT_LABEL,
    settings: |dir| {
        let path = dir.join("compact.txt").to_string_lossy().into_owned();
        worker_settings(false, true, Some(path))
    },
    guard: |e| &e.watch.auto_compact_guard_checks,
};

/// Attach `kind` to the `s1` tab of `engine`, under the real 10 s window.
fn arm(engine: &mut Engine, kind: &BuiltIn, dir: &std::path::Path) {
    engine.watch.built_in_startup_settle = None;
    let settings = (kind.settings)(dir);
    if let Some(path) = settings.compact_instructions_path.clone() {
        engine.process_compact_instructions_loaded(
            path,
            CompactCommandLoad {
                command: "/compact".to_string(),
                warning: None,
            },
        );
    }
    engine
        .amq
        .session_settings
        .insert("s1".to_string(), settings);
}

/// Tick every 100 ms of logical time from `from` until just past the window
/// and one rescan interval after it, and return the instant reached.
fn tick_through_window(engine: &mut Engine, from: Instant) -> Instant {
    let end = from + WATCH_BUILT_IN_STARTUP_SETTLE + WATCH_RESCAN_INTERVAL;
    let mut now = from;
    while now <= end {
        engine.tick_watch_rules_at(now);
        now += Duration::from_millis(100);
    }
    now
}

/// The tab shows the replayed sentinel throughout the window, which neither
/// schedules the built-in nor asks its guard; `print_new` then puts a fresh
/// one under it, which schedules it on the first rescan after the window.
fn assert_replay_held_then_new_fires(mut engine: Engine, kind: &BuiltIn, print_new: impl FnOnce()) {
    let tab = TabIdRef::new("s1-slot");
    let screen = |e: &Engine| e.providers[tab].scan_recent_lines(WATCH_SCAN_ROWS);
    let replayed = format!("replayed: {}", kind.sentinel);
    assert!(wait_for(|| screen(&engine).contains(&replayed)));

    let spawned_at = engine.providers[tab].spawned_at;
    let now = tick_through_window(&mut engine, spawned_at);
    assert_eq!(
        row_state(&engine, kind.label),
        Some(RuleStateKind::Idle),
        "a replayed {} must not schedule its built-in",
        kind.sentinel
    );
    assert_eq!(
        (kind.guard)(&engine).load(Relaxed),
        0,
        "the replay was absorbed, never offered to the guard"
    );

    print_new();
    let fresh = format!("new work: {}", kind.sentinel);
    assert!(wait_for(|| screen(&engine).contains(&fresh)));
    engine.tick_watch_rules_at(now + WATCH_RESCAN_INTERVAL);
    assert_eq!(
        row_state(&engine, kind.label),
        Some(RuleStateKind::Pending),
        "a {} printed after the window schedules its built-in",
        kind.sentinel
    );
}

/// A launched agent that redraws its old transcript, then prints a new
/// sentinel once the test creates `go`.
fn replaying_launch(kind: &BuiltIn, go: &std::path::Path) -> PtyClient {
    let s = kind.sentinel;
    let script = format!(
        "printf 'replayed: {s}\\n'; while [ ! -e '{}' ]; do sleep 0.02; done; \
         printf 'new work: {s}\\n'; exec sleep 30",
        go.display()
    );
    PtyClient::spawn(
        "sh",
        &["-c".to_string(), script],
        &std::env::temp_dir(),
        24,
        80,
        100,
    )
    .expect("spawn replaying pty")
}

fn assert_launch_replay_is_held(kind: &BuiltIn) {
    let tmp = crate::test_scratch::ScratchDir::new();
    let go = tmp.path().join("go");
    let (mut engine, _guard) = engine_with_tab(replaying_launch(kind, &go), Vec::new());
    arm(&mut engine, kind, tmp.path());
    assert_replay_held_then_new_fires(engine, kind, || std::fs::write(&go, b"").unwrap());
}

#[test]
fn a_task_done_replayed_after_a_launch_does_not_clear_the_agent() {
    assert_launch_replay_is_held(&AUTO_CLEAR);
}

#[test]
fn a_compact_replayed_after_a_launch_does_not_compact_the_agent() {
    assert_launch_replay_is_held(&AUTO_COMPACT);
}

/// A reload adopts the terminal with the previous image's screen replayed
/// into it before any tick runs; the window starts at the adoption.
fn assert_adoption_replay_is_held(kind: &BuiltIn) {
    use std::io::Write;
    use std::os::fd::{FromRawFd, RawFd};

    let (mut master, mut slave): (RawFd, RawFd) = (-1, -1);
    // SAFETY: `openpty` only fills the two fds it is given.
    let rc = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    assert_eq!(rc, 0, "openpty: {}", std::io::Error::last_os_error());
    // SAFETY: freshly opened above; this scope is its only owner.
    let mut agent_side = unsafe { std::fs::File::from_raw_fd(slave) };
    let mut agent = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .expect("spawn the adopted agent");
    let repaint = format!("replayed: {}\r\n", kind.sentinel);
    // SAFETY: `master` was opened above and nothing else owns it.
    let client = unsafe {
        PtyClient::adopt_after_reload(
            master,
            Some(agent.id()),
            24,
            80,
            100,
            &std::env::temp_dir(),
            repaint.as_bytes(),
        )
    }
    .expect("adopt the pty");

    let tmp = crate::test_scratch::ScratchDir::new();
    let (mut engine, _guard) = engine_with_tab(client, Vec::new());
    arm(&mut engine, kind, tmp.path());
    assert_replay_held_then_new_fires(engine, kind, || {
        write!(agent_side, "new work: {}\r\n", kind.sentinel).unwrap();
    });
    let _ = agent.kill();
    let _ = agent.wait();
}

#[test]
fn a_task_done_replayed_after_a_reload_does_not_clear_the_agent() {
    assert_adoption_replay_is_held(&AUTO_CLEAR);
}

#[test]
fn a_compact_replayed_after_a_reload_does_not_compact_the_agent() {
    assert_adoption_replay_is_held(&AUTO_COMPACT);
}

/// The window holds only the built-in rules: a user rule still answers a
/// prompt the agent shows as it starts.
#[test]
fn a_user_rule_still_answers_a_startup_prompt_inside_the_window() {
    let tmp = crate::test_scratch::ScratchDir::new();
    let (mut engine, _guard) = engine_with_tab(
        printing_pty("Trust this folder? [task-done]"),
        vec![instant_rule("Trust this folder", "yes")],
    );
    arm(&mut engine, &AUTO_CLEAR, tmp.path());
    let tab = TabIdRef::new("s1-slot");
    assert!(wait_for(|| engine.providers[tab]
        .scan_recent_lines(WATCH_SCAN_ROWS)
        .contains("Trust this folder")));
    let start = engine.providers[tab].spawned_at;
    let mut statuses = engine.tick_watch_rules_at(start);
    statuses.extend(engine.tick_watch_rules_at(start + Duration::from_millis(100)));
    assert!(
        statuses
            .iter()
            .any(|s| s.message.contains("fired (attempt 1/3)")),
        "{statuses:?}"
    );
    assert_eq!(
        row_state(&engine, AUTO_CLEAR_LABEL),
        Some(RuleStateKind::Idle),
        "the built-in stays held inside the window"
    );
}

/// The rescan budget binds when many agents start together, yet every tab is
/// rescanned inside its window, so none first reads its replay after the
/// window and takes it as fresh.
#[test]
fn every_tab_of_a_herd_is_rescanned_inside_its_window() {
    const N: usize = 12;
    assert!(
        watch_rescans_per_tick(N) < N,
        "the test needs the cap to bind"
    );
    let (mut engine, _guard, tabs) = engine_with_tabs(N, || printing_pty("replayed: [task-done]"));
    engine.watch.built_in_startup_settle = None;
    for (i, tab) in tabs.iter().enumerate() {
        engine
            .amq
            .session_settings
            .insert(format!("s{}", i + 1), worker_settings(true, false, None));
        assert!(wait_for(|| engine.providers[tab.as_ref_id()]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("replayed")));
    }
    let latest = tabs
        .iter()
        .map(|t| engine.providers[t.as_ref_id()].spawned_at)
        .max()
        .unwrap();
    tick_through_window(&mut engine, latest);
    for tab in &tabs {
        assert!(
            engine.watch.last_snapshot.contains_key(tab),
            "{tab:?} was never rescanned"
        );
    }
    assert_eq!(
        engine.watch.auto_clear_guard_checks.load(Relaxed),
        0,
        "a tab first rescanned after its window took its replay as fresh"
    );
    assert!(
        engine
            .watch_rule_rows()
            .iter()
            .filter(|r| r.snapshot.label == AUTO_CLEAR_LABEL)
            .all(|r| r.snapshot.state == RuleStateKind::Idle)
    );
}
