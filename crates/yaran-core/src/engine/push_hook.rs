//! The engine side of phone notifications: edges from the tick, events from engine data.
//!
//! `observe_push_tick` runs at the one hook every serving mode shares
//! (`poll_agent_signals`), feeding the push-only set the same `fired` list and `engaged`
//! predicate as the sidebar set; `observe_push_bad_exit` runs where a bad ending is
//! recorded. Events carry ids, the agent's label, its project and a RowState token, never
//! terminal output. The identity a raise was sent under is remembered, so its clear
//! collapses the same phone notification even after the tab or the agent is gone.
//!
//! - Runs on the engine thread; hands owned events to the emitter with `try_send`.
//!
//! <module-headers:begin>
//! Uses:
//! engine/push_hook.rs
//! ├── cloud::config
//! ├── cloud::protocol::machine
//! ├── cloud::push_config
//! ├── cloud::push_edges
//! ├── cloud::push_emitter
//! ├── cloud::push_link
//! ├── cloud::push_queue
//! ├── config
//! ├── engine
//! ├── engine::attention_decision
//! ├── engine::push_hook::tests
//! ├── ids
//! ├── model
//! ├── row_state
//! ├── sanitize
//! ├── tab_verdict
//! └── worker
//! External: std, tracing
//!
//! Used by:
//! engine/push_hook.rs
//! ├── engine
//! └── engine::push_hook::tests
//! <module-headers:end>

use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use super::Engine;
use super::attention_decision::attention_engaged;
use crate::cloud::config::CloudMode;
use crate::cloud::protocol::machine::{
    AttentionEvent, AttentionKind, EndingToken, Event, ExitEvent, ExitKind, RowStateToken,
};
use crate::cloud::push_config::PushSettings;
use crate::cloud::push_edges::{EdgeKind, PushEdges};
use crate::cloud::push_emitter::PushEmitter;
use crate::cloud::push_link::paired_link_factory;
use crate::cloud::push_queue::{event_ts, new_event_id};
use crate::config::{Config, YaranPaths};
use crate::ids::{TabId, TabIdRef};
use crate::model::AgentWorkspace;
use crate::row_state::{RowState, agent_row_state};
use crate::tab_verdict::TabRunEnding;
use crate::worker::WorkerEvent;

/// 02's `maxLength` for `label` and `project`.
const NAME_MAX_CHARS: usize = 64;

/// The engine's push state: the shadow set, the emitter, and what each raise was sent as.
pub struct PushHook {
    edges: PushEdges,
    pub emitter: PushEmitter,
    raised: HashMap<TabId, Origin>,
}

impl PushHook {
    /// The engine's hook: events go out signed as the machine paired under `paths`.
    pub fn new(config: &Config, paths: &YaranPaths, status_lane: Sender<WorkerEvent>) -> Self {
        let link = paired_link_factory(
            &paths.root,
            Duration::from_secs(config.cloud.request_timeout_seconds.max(1)),
        );
        Self::with_emitter(PushEmitter::with_link(
            push_settings(config),
            Some(status_lane),
            link,
        ))
    }

    /// Push off and no status lane (test engines).
    pub fn off() -> Self {
        Self::with_emitter(PushEmitter::off())
    }

    pub fn with_emitter(emitter: PushEmitter) -> Self {
        Self {
            edges: PushEdges::default(),
            emitter,
            raised: HashMap::new(),
        }
    }
}

/// The emitter's settings from config: on while `push_notifications` and mode is not `no`.
pub(crate) fn push_settings(config: &Config) -> PushSettings {
    let cloud = &config.cloud;
    PushSettings::new(
        cloud.push_notifications && cloud.mode() != CloudMode::No,
        &cloud.push,
    )
}

#[derive(Debug, Clone)]
struct Origin {
    agent_id: String,
    tab_id: Option<String>,
    label: Option<String>,
    project: Option<String>,
}

fn state_token(state: RowState) -> RowStateToken {
    match state {
        RowState::NeedsAttention => RowStateToken::NeedsAttention,
        RowState::Typing => RowStateToken::Typing,
        RowState::Busy => RowStateToken::Busy,
        RowState::Idle => RowStateToken::Idle,
        RowState::Detached => RowStateToken::Detached,
        RowState::Exited => RowStateToken::Exited,
    }
}

fn ending_token(ending: &TabRunEnding) -> EndingToken {
    match ending {
        TabRunEnding::LaunchFailed { .. } => EndingToken::LaunchFailed,
        TabRunEnding::ExitedWithStatus { .. } => EndingToken::Exited,
        TabRunEnding::ExitedUnknownStatus => EndingToken::ExitedUnknown,
        TabRunEnding::RapidCleanExit => EndingToken::RapidCleanExit,
    }
}

impl Engine {
    /// One tick of the push-only set; called right after the sidebar's decision.
    pub(super) fn observe_push_tick(&mut self, fired: &[TabId], now: Instant) {
        let enabled = self.push.emitter.is_on();
        let viewed = &self.agent_viewed;
        let typed = &self.pty_input;
        let providers = &self.providers;
        let edges = self.push.edges.observe(
            fired,
            enabled,
            |tab| attention_engaged(viewed, typed, tab, now),
            |tab| providers.contains_key(tab),
        );
        if !enabled {
            // Off sends nothing, including the clears for what was raised.
            self.push.raised.clear();
            return;
        }
        for edge in edges {
            tracing::debug!(target: "yaran::cloud::push", tab = %edge.tab, kind = ?edge.kind, "attention edge");
            let event = match edge.kind {
                EdgeKind::Raised => {
                    let Some(origin) = self.push_origin(&edge.tab) else {
                        continue;
                    };
                    self.push.raised.insert(edge.tab.clone(), origin.clone());
                    attention_event(
                        origin,
                        AttentionKind::AttentionRaised,
                        RowStateToken::NeedsAttention,
                    )
                }
                EdgeKind::Cleared => {
                    let origin = self
                        .push
                        .raised
                        .remove(&edge.tab)
                        .or_else(|| self.push_origin(&edge.tab));
                    let Some(origin) = origin else { continue };
                    let state = self.state_after_clear(&origin.agent_id);
                    attention_event(origin, AttentionKind::AttentionCleared, state)
                }
            };
            self.push.emitter.offer(event);
        }
    }

    /// A bad ending, unless the user is looking at (or just started) the tab.
    pub(super) fn observe_push_bad_exit(&mut self, tab: &TabIdRef, ending: &TabRunEnding) {
        if !self.push.emitter.is_on()
            || attention_engaged(&self.agent_viewed, &self.pty_input, tab, Instant::now())
        {
            return;
        }
        let Some(origin) = self.push_origin(tab) else {
            return;
        };
        self.push.emitter.offer(Event::Exit(ExitEvent {
            id: new_event_id(),
            kind: ExitKind::AgentExitedBadly,
            ts: event_ts(),
            agent_id: origin.agent_id,
            tab_id: origin.tab_id,
            ending: ending_token(ending),
            exit_status: ending.status().map(i64::from),
            project: origin.project,
            label: origin.label,
        }));
    }

    fn push_origin(&self, tab: &TabIdRef) -> Option<Origin> {
        let session_id = self.owning_session_for_tab(tab.as_str())?;
        let session = self.session_by_id(&session_id)?;
        let project = match &session.workspace {
            AgentWorkspace::Managed(managed) => self
                .projects
                .iter()
                .find(|p| p.id == managed.project_id)
                .map(|p| p.name.clone()),
            // The folder's last component only; the path never leaves the machine.
            AgentWorkspace::Folder(folder) => std::path::Path::new(&folder.folder_path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
        };
        Some(Origin {
            agent_id: session.id.clone(),
            // The first tab is the agent itself: decided by the pointer, never by position.
            tab_id: (!session.is_slot_tab(tab)).then(|| tab.as_str().to_string()),
            label: Some(crate::sanitize::truncate(
                &session.display_label(),
                NAME_MAX_CHARS,
            )),
            project: project.map(|p| crate::sanitize::truncate(&p, NAME_MAX_CHARS)),
        })
    }

    /// The agent's row state after the clear; `idle` when it no longer resolves.
    fn state_after_clear(&self, agent_id: &str) -> RowStateToken {
        let Some(session) = self.session_by_id(agent_id) else {
            return RowStateToken::Idle;
        };
        state_token(agent_row_state(
            session.status,
            self.session_is_streaming(agent_id),
            self.session_is_typing(agent_id),
            false,
        ))
    }
}

fn attention_event(origin: Origin, kind: AttentionKind, state: RowStateToken) -> Event {
    Event::Attention(AttentionEvent {
        id: new_event_id(),
        kind,
        ts: event_ts(),
        agent_id: origin.agent_id,
        tab_id: origin.tab_id,
        state,
        project: origin.project,
        label: origin.label,
    })
}

#[cfg(test)]
#[path = "push_hook_tests.rs"]
mod tests;
