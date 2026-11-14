//! Tests for the engine's push hook: edge semantics end to end through
//! `poll_agent_signals`, independence from `ui.attention_indicator`, and event content.
//!
//! - Test-only (`#[cfg(test)]` child of `engine::push_hook`); real PTYs via
//!   `seed_signaling_provider`.
//!
//! <module-headers:begin>
//! Uses:
//! engine/push_hook_tests.rs
//! ├── cloud::protocol
//! ├── cloud::protocol::machine
//! ├── cloud::push_config
//! ├── cloud::push_emitter
//! ├── engine
//! ├── engine::push_hook
//! ├── engine::test_support
//! ├── ids
//! ├── model
//! ├── tab_verdict
//! └── test_scratch
//! External: serde_json, std
//!
//! Used by:
//! engine/push_hook_tests.rs
//! └── engine::push_hook
//! <module-headers:end>

use std::collections::HashSet;
use std::sync::mpsc::Receiver;
use std::time::Instant;

use super::PushHook;
use crate::cloud::protocol::Validate;
use crate::cloud::protocol::machine::{
    AttentionEvent, AttentionKind, EndingToken, Event, ExitEvent, RowStateToken,
};
use crate::cloud::push_config::PushSettings;
use crate::cloud::push_emitter::{Msg, PushEmitter};
use crate::engine::Engine;
use crate::engine::test_support::{
    sample_project, sample_session, sample_standalone_session, sample_tab, seed_signaling_provider,
    test_engine,
};
use crate::ids::{TabId, TabIdRef};
use crate::model::SessionStatus;
use crate::tab_verdict::TabRunEnding;

/// An engine with one managed agent `s1` (slot tab `s1-slot`) in project `p1`, push
/// captured into the returned receiver.
fn engine_with_agent(capacity: usize) -> (Engine, Receiver<Msg>, crate::test_scratch::ScratchDir) {
    let (mut engine, tmp) = test_engine();
    engine.config.ui.attention_on_bell = true;
    engine.projects.push(sample_project("p1", "/tmp/p1"));
    engine.sessions.push(sample_session("s1", "p1", "feat"));
    let (emitter, rx) = PushEmitter::capture(capacity);
    engine.push = PushHook::with_emitter(emitter);
    (engine, rx, tmp)
}

fn drain(rx: &Receiver<Msg>) -> Vec<Event> {
    let events: Vec<Event> = rx
        .try_iter()
        .map(|msg| match msg {
            Msg::Offer(event) => event,
            Msg::Retune(_) => panic!("no retune expected"),
        })
        .collect();
    for e in &events {
        assert!(e.validate().is_ok(), "every event validates: {e:?}");
    }
    events
}

fn attention(e: &Event) -> &AttentionEvent {
    match e {
        Event::Attention(a) => a,
        Event::Exit(_) => panic!("expected an attention event, got {e:?}"),
    }
}

fn exit(e: &Event) -> &ExitEvent {
    match e {
        Event::Exit(x) => x,
        Event::Attention(_) => panic!("expected an exit event, got {e:?}"),
    }
}

#[test]
fn push_hook_indicator_off_still_emits_and_the_sidebar_stays_quiet() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    engine.config.ui.attention_indicator = false;
    let _wt = seed_signaling_provider(&mut engine, "s1-slot");

    engine.poll_agent_signals();

    assert!(!engine.tab_needs_attention("s1-slot"));
    let events = drain(&rx);
    assert_eq!(events.len(), 1);
    let raise = attention(&events[0]);
    assert_eq!(raise.kind, AttentionKind::AttentionRaised);
    assert_eq!(raise.state, RowStateToken::NeedsAttention);
    assert_eq!(raise.agent_id, "s1");
    assert_eq!(raise.tab_id, None, "the first tab is the agent itself");
    assert_eq!(raise.label.as_deref(), Some("s1-title"));
    assert_eq!(raise.project.as_deref(), Some("p1-name"));
}

#[test]
fn push_hook_indicator_on_and_push_off_emits_nothing() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    engine.config.ui.attention_indicator = true;
    engine.push.emitter.retune(PushSettings::off());
    let _wt = seed_signaling_provider(&mut engine, "s1-slot");

    engine.poll_agent_signals();

    assert!(engine.tab_needs_attention("s1-slot"));
    assert!(rx.try_recv().is_err(), "push off offers nothing");
}

#[test]
fn push_hook_view_and_provider_gone_each_clear_with_the_post_clear_state() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    let _wt = seed_signaling_provider(&mut engine, "s1-slot");
    engine.poll_agent_signals();
    assert_eq!(drain(&rx).len(), 1);

    // Viewed: the push set clears on the next tick through `engaged`.
    engine.note_agent_viewed("s1-slot");
    engine.poll_agent_signals();
    let events = drain(&rx);
    assert_eq!(events.len(), 1);
    let clear = attention(&events[0]);
    assert_eq!(clear.kind, AttentionKind::AttentionCleared);
    assert_eq!(
        clear.state,
        RowStateToken::Detached,
        "sample sessions are detached"
    );
    assert_eq!(clear.tab_id, None);

    // Raise again on a fresh signal, then the agent is deleted outright.
    engine.agent_viewed.clear();
    let _wt2 = seed_signaling_provider(&mut engine, "s1-slot");
    engine.poll_agent_signals();
    assert_eq!(drain(&rx).len(), 1);
    engine.clear_tab_runtime(TabIdRef::new("s1-slot"));
    engine.sessions.clear();
    engine.poll_agent_signals();
    let events = drain(&rx);
    assert_eq!(events.len(), 1);
    let clear = attention(&events[0]);
    assert_eq!(clear.kind, AttentionKind::AttentionCleared);
    assert_eq!(
        clear.agent_id, "s1",
        "the raise's identity survives the delete"
    );
    assert_eq!(
        clear.state,
        RowStateToken::Idle,
        "a vanished agent reads idle"
    );
}

#[test]
fn push_hook_bad_exit_emits_its_ending_unless_engaged() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    engine.sessions[0].status = SessionStatus::Exited;
    engine.mark_tab_run_failed(
        TabIdRef::new("s1-slot"),
        TabRunEnding::ExitedWithStatus { status: 3 },
        Vec::new(),
    );
    let events = drain(&rx);
    assert_eq!(events.len(), 1);
    let x = exit(&events[0]);
    assert_eq!(x.ending, EndingToken::Exited);
    assert_eq!(x.exit_status, Some(3));
    let json = serde_json::to_value(&events[0]).expect("serializes");
    assert!(json.get("state").is_none(), "an exit carries no state");
    assert_eq!(
        json["ending"],
        TabRunEnding::ExitedWithStatus { status: 3 }.wire_kind()
    );

    engine.mark_tab_run_failed(
        TabIdRef::new("s1-slot"),
        TabRunEnding::RapidCleanExit,
        Vec::new(),
    );
    let events = drain(&rx);
    assert_eq!(exit(&events[0]).exit_status, None);
    assert_eq!(
        serde_json::to_value(&events[0]).expect("serializes")["ending"],
        TabRunEnding::RapidCleanExit.wire_kind()
    );

    engine.note_agent_viewed("s1-slot");
    engine.mark_tab_run_failed(
        TabIdRef::new("s1-slot"),
        TabRunEnding::ExitedUnknownStatus,
        Vec::new(),
    );
    assert!(
        drain(&rx).is_empty(),
        "someone looking at the tab already sees it"
    );
}

#[test]
fn push_hook_extra_tabs_carry_their_id_and_the_slot_follows_the_pointer() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    engine
        .agent_tabs
        .insert(TabId::new("t2"), sample_tab("t2", "s1", "claude", 1));
    let _a = seed_signaling_provider(&mut engine, "t2");
    engine.observe_push_tick(&[TabId::new("t2")], Instant::now());
    let events = drain(&rx);
    assert_eq!(attention(&events[0]).tab_id.as_deref(), Some("t2"));

    // The first tab closes and `t2` is promoted: it is now the agent itself. Its clear
    // still names `t2` (the identity it was raised under, so the phone collapses it).
    engine.sessions[0].slot_tab_id = "t2".into();
    engine.agent_tabs.clear();
    engine.note_agent_viewed("t2");
    engine.observe_push_tick(&[], Instant::now());
    let events = drain(&rx);
    assert_eq!(attention(&events[0]).tab_id.as_deref(), Some("t2"));
    engine.agent_viewed.clear();
    engine.observe_push_tick(&[TabId::new("t2")], Instant::now());
    let events = drain(&rx);
    assert_eq!(events.len(), 1);
    assert_eq!(attention(&events[0]).tab_id, None);
}

#[test]
fn push_hook_event_ids_are_distinct() {
    let (mut engine, rx, _tmp) = engine_with_agent(64);
    let _wt = seed_signaling_provider(&mut engine, "s1-slot");
    for _ in 0..5 {
        engine.observe_push_tick(&[TabId::new("s1-slot")], Instant::now());
        engine.note_agent_viewed("s1-slot");
        engine.observe_push_tick(&[], Instant::now());
        engine.agent_viewed.clear();
    }
    let events = drain(&rx);
    assert_eq!(events.len(), 10);
    let ids: HashSet<&str> = events.iter().map(|e| attention(e).id.as_str()).collect();
    assert_eq!(ids.len(), 10);
}

#[test]
fn push_hook_standalone_agent_sends_its_folder_name_and_labels_truncate_by_chars() {
    let (mut engine, rx, _tmp) = engine_with_agent(16);
    let mut standalone = sample_standalone_session("s2", "/home/someone/projects/my-folder");
    standalone.title = Some("é".repeat(100));
    engine.sessions.push(standalone);
    let _wt = seed_signaling_provider(&mut engine, "s2-slot");
    engine.observe_push_tick(&[TabId::new("s2-slot")], Instant::now());
    let events = drain(&rx);
    let raise = attention(&events[0]);
    assert_eq!(raise.project.as_deref(), Some("my-folder"));
    let label = raise.label.as_deref().expect("label");
    assert_eq!(label.chars().count(), 64);
    assert!(label.ends_with('…'));
}

#[test]
fn push_hook_never_blocks_on_a_full_channel() {
    let (mut engine, _rx, _tmp) = engine_with_agent(1);
    engine.sessions.push(sample_session("s2", "p1", "other"));
    let _a = seed_signaling_provider(&mut engine, "s1-slot");
    let _b = seed_signaling_provider(&mut engine, "s2-slot");
    let started = Instant::now();
    engine.observe_push_tick(
        &[TabId::new("s1-slot"), TabId::new("s2-slot")],
        Instant::now(),
    );
    assert!(started.elapsed() < std::time::Duration::from_millis(100));
    assert_eq!(engine.push.emitter.dropped(), 1);
}
