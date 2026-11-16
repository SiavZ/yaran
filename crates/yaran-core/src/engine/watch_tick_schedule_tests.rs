//! Tests for the watch tick's rescan schedule: a busy screen is rescanned at
//! most once per interval, the per-tick budget spreads a herd of busy tabs,
//! round-robin keeps every tab moving, and an unchanged grid is never rescanned.
//!
//! - Test-only (`#[cfg(test)]` child of `engine::watch_tick`); real PTYs, with
//!   the fairness checks driven on a logical clock.

use std::time::{Duration, Instant};

use super::tests::{engine_with_tab, instant_rule, wait_for};
use super::*;
use crate::engine::test_support::sample_session;
use crate::pty::PtyClient;

/// A screen that changes on every tick (a working agent's spinner) is
/// rescanned at most once per `WATCH_RESCAN_INTERVAL`, and a match that
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

/// A PTY whose screen changes only when the test types at it: the line
/// discipline echoes each byte, so a write is a deterministic redraw.
fn echo_pty() -> PtyClient {
    PtyClient::spawn(
        "sh",
        &[
            "-c".to_string(),
            "printf 'ready\\n'; exec sleep 30".to_string(),
        ],
        &std::env::temp_dir(),
        24,
        80,
        100,
    )
    .expect("spawn echo pty")
}

/// `n` agents whose slot tabs all run `spawn()` and one claude rule.
pub(super) fn engine_with_tabs(
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

/// Drive `N` always-changed tabs for `ticks` ticks, `tick` apart on a
/// logical clock, and check the rescan schedule in ticks: no tick exceeds
/// the budget, every tab is rescanned, none sooner than its interval and
/// none later than the ticks the budget needs to drain every tab after it
/// falls due. Logical time keeps host scheduling out of the verdict; the
/// grids are made to change before each tick, so a due tab that is not
/// rescanned can only be the scheduler's doing. Returns the largest
/// number of rescans one tick did.
fn assert_busy_tabs_are_fairly_rescanned(tick: Duration, ticks: u32) -> usize {
    const N: usize = 12;
    let (mut engine, _guard, tabs) = engine_with_tabs(N, echo_pty);
    for tab in &tabs {
        assert!(wait_for(|| engine.providers[tab.as_ref_id()]
            .scan_recent_lines(WATCH_SCAN_ROWS)
            .contains("ready")));
    }
    let cap = watch_rescans_per_tick(N);
    assert!(cap < N, "the test needs the cap to bind");
    let due_ticks =
        u32::try_from(WATCH_RESCAN_INTERVAL.as_nanos().div_ceil(tick.as_nanos())).unwrap();
    let drain_ticks = u32::try_from(N.div_ceil(cap)).unwrap();

    let t0 = Instant::now();
    let mut most = 0;
    let mut scanned: std::collections::HashMap<TabId, Vec<u32>> =
        std::collections::HashMap::default();
    for k in 0..ticks {
        let now = t0 + tick * k;
        let before = engine.watch.rescans;
        engine.tick_watch_rules_at(now);
        let did = engine.watch.rescans - before;
        assert!(did <= cap, "tick {k} rescanned {did} tabs, cap {cap}");
        most = most.max(did);
        for tab in &tabs {
            let Some(snap) = engine.watch.last_snapshot.get(tab) else {
                continue;
            };
            if snap.scanned_at != now {
                continue;
            }
            scanned.entry(tab.clone()).or_default().push(k);
            // Busy: the grid moves on before the tab is due again.
            let client = &engine.providers[tab.as_ref_id()];
            client.write_bytes(b"x").unwrap();
            let seen = Some(snap.generation);
            assert!(wait_for(|| client
                .scan_recent_lines_if_changed(WATCH_SCAN_ROWS, seen)
                .is_some()));
        }
    }
    assert_eq!(scanned.len(), N, "a tab was never rescanned: {scanned:?}");
    for (tab, at) in &scanned {
        assert!(
            at[0] < drain_ticks,
            "{tab:?} first rescanned at tick {}",
            at[0]
        );
        for w in at.windows(2) {
            let gap = w[1] - w[0];
            assert!(
                gap >= due_ticks,
                "{tab:?} rescanned after {gap} ticks, interval is {due_ticks}"
            );
            assert!(
                gap < due_ticks + drain_ticks,
                "{tab:?} waited {gap} ticks, due after {due_ticks}: {at:?}"
            );
        }
        let last = *at.last().unwrap();
        assert!(
            ticks - 1 - last < due_ticks + drain_ticks - 1,
            "{tab:?} starved after tick {last} of {ticks}"
        );
    }
    most
}

/// A fast tick: the interval is what limits each busy tab, and the herd
/// that starts together is spread over the ticks the budget needs.
#[test]
fn busy_tabs_are_spread_across_ticks_and_none_starves() {
    let most = assert_busy_tabs_are_fairly_rescanned(Duration::from_millis(10), 120);
    assert_eq!(most, watch_rescans_per_tick(12), "the cap must bind");
}

/// A slow tick: more tabs fall due every tick than the budget allows, so
/// only the round-robin keeps every tab moving.
#[test]
fn a_budget_that_binds_every_tick_still_reaches_every_busy_tab() {
    let most = assert_busy_tabs_are_fairly_rescanned(Duration::from_millis(100), 18);
    assert_eq!(most, watch_rescans_per_tick(12), "the cap must bind");
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
