//! The human board ("Tasks for Human") for the browser: read the cards, mark
//! one done or reopen it, and reply on it.
//!
//! - `GET  /api/v1/board`: who is on the board and its cards (open, then the
//!   recently resolved).
//! - `POST /api/v1/board/cards/{id}/resolve`: mark a card done.
//! - `POST /api/v1/board/cards/{id}/reopen`: put a resolved card back.
//! - `POST /api/v1/board/cards/{id}/reply`: add to a card's conversation.
//! - `POST /api/v1/board/cards/{id}/assign`: hand an open task to a person's
//!   queue (or to nobody's in particular).
//! - `POST /api/v1/board/cards/{id}/priority`: change how urgent a card is.
//! - `POST /api/v1/board/cards/{id}/summary`: ask its agent for an updated TL;DR.
//!
//! The board is a file or a folder of notes (`yaran_core::human_board`), so
//! every read and write runs off the reactor, under the store's own lock.
//!
//! A reply to a card an agent of this yaran posted, while that agent runs,
//! is also sent to it with `yaran peer send` (the route the board's relay
//! already takes), in the words the terminal UI types
//! (`[ui] human_board_reply_template`). The send comes first: a send that
//! fails adds nothing to the card, so the reply stays in the browser's box,
//! as the terminal UI refuses a reply to an agent that is not running.

use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use yaran_core::human_board::relay::{self, RelayJob};
use yaran_core::human_board::{
    Board, BoardSettings, Card, CardId, CardKind, NewMessage, Priority, render_reply, same_person,
};

use crate::server::AppState;

#[path = "board_summary.rs"]
mod summary;

/// Who the board records as resolving a card from the browser, the same
/// name the terminal UI records.
const RESOLVED_BY: &str = "human";
/// How many resolved cards the browser gets under "Done": enough to undo a
/// slip, as in the terminal UI. `yaran board list --all` is the history.
const RECENT_DONE: usize = 5;

/// What the routes need from the engine, cloned in one engine turn.
#[derive(Clone, Debug)]
pub struct BoardInputs {
    settings: BoardSettings,
    reply_template: String,
    /// `(agent handle, label)` of every agent with a live provider here.
    running_agents: Vec<(String, String)>,
    /// The yaran binary a reply is sent with.
    exe: Option<PathBuf>,
}

impl BoardInputs {
    pub(crate) fn from_engine(engine: &yaran_core::engine::Engine) -> Self {
        let running_agents = engine
            .sessions
            .iter()
            .filter(|s| s.deleted_at.is_none() && engine.session_has_live_provider(&s.id))
            .map(|s| (s.agent_handle.clone(), s.display_label()))
            .collect();
        Self {
            settings: BoardSettings::from_config(&engine.config.board, &engine.paths.root),
            reply_template: engine.config.ui.human_board_reply_template.clone(),
            running_agents,
            exe: yaran_core::reload_policy::reload_exe(),
        }
    }

    /// The person writing from this yaran: `[board] me`, or "human".
    fn writer(&self) -> String {
        self.settings
            .me
            .clone()
            .unwrap_or_else(|| RESOLVED_BY.to_string())
    }

    /// The running agent of this yaran that posted `card`, as
    /// `(handle, label)`. A card from another person's board is somebody
    /// else's agent, whatever its handle.
    fn poster_here(&self, card: &Card) -> Option<&(String, String)> {
        let elsewhere = match (self.settings.me.as_deref(), self.settings.origin_of(card)) {
            (Some(me), Some(origin)) => !same_person(&origin, me),
            _ => false,
        };
        if elsewhere {
            return None;
        }
        let handle = yaran_core::model::normalize_agent_handle(card.from.as_deref()?);
        self.running_agents.iter().find(|(h, _)| *h == handle)
    }
}

/// The board routes.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/board", get(read_board))
        .route("/api/v1/board/cards/{id}/resolve", post(resolve_card))
        .route("/api/v1/board/cards/{id}/reopen", post(reopen_card))
        .route("/api/v1/board/cards/{id}/reply", post(reply_card))
        .route("/api/v1/board/cards/{id}/assign", post(assign_card))
        .route("/api/v1/board/cards/{id}/priority", post(set_priority))
        .route(
            "/api/v1/board/cards/{id}/summary",
            post(summary::request_summary),
        )
}

/// One card as the browser reads it.
#[derive(Serialize)]
struct CardView {
    #[serde(flatten)]
    card: Card,
    /// `#12`, or `#12 [4812]`.
    label: String,
    /// The poster cannot carry on until a person answers.
    waiting: bool,
    /// The running agent a reply goes to, by label; `None` when a reply only
    /// joins the conversation.
    reply_agent: Option<String>,
    summary_revision: String,
    summary_current: bool,
    /// The existing agent that can summarize this card.
    summary_agent: Option<String>,
}

#[derive(Serialize)]
struct BoardView {
    people: Vec<String>,
    me: Option<String>,
    /// Open cards in the board's order, then the recently resolved.
    cards: Vec<CardView>,
    /// Notes of a folder board that could not be read, one sentence each.
    problems: Vec<String>,
}

fn board_view(board: &Board, inputs: &BoardInputs) -> BoardView {
    let view = |card: &Card| CardView {
        card: card.clone(),
        label: card.label(),
        waiting: card.waits_for_answer(&inputs.settings.people),
        reply_agent: inputs.poster_here(card).map(|(_, label)| label.clone()),
        summary_revision: card.summary_revision(),
        summary_current: card.summary_current(),
        summary_agent: inputs.summary_agent(card).map(|(_, label)| label.clone()),
    };
    let cards = board
        .open_cards()
        .into_iter()
        .chain(board.recently_resolved(RECENT_DONE))
        .map(view)
        .collect();
    BoardView {
        people: inputs.settings.people.clone(),
        me: inputs.settings.me.clone(),
        cards,
        problems: board.problems.clone(),
    }
}

/// A refusal the browser shows as it is.
type Refusal = (StatusCode, String);

/// Card text and paths are cleaned of terminal sequences first.
fn refusal(status: StatusCode, error: &anyhow::Error) -> Refusal {
    (
        status,
        yaran_core::sanitize::for_terminal(&format!("{error:#}")),
    )
}

async fn inputs(state: &AppState) -> Result<BoardInputs, Refusal> {
    state.engine.board_inputs().await.ok_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "yaran is shutting down".to_string(),
        )
    })
}

/// Run blocking board work off the reactor and answer its JSON.
async fn blocking<T: Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, Refusal> + Send + 'static,
) -> Response {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(refusal)) => refusal.into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the board request stopped before it answered: {error}"),
        )
            .into_response(),
    }
}

async fn read_board(State(state): State<AppState>) -> Response {
    let inputs = match inputs(&state).await {
        Ok(inputs) => inputs,
        Err(refusal) => return refusal.into_response(),
    };
    blocking(move || {
        let board = inputs
            .settings
            .store
            .load()
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        Ok(board_view(&board, &inputs))
    })
    .await
}

/// The card `query` names, or a 404 saying why.
fn find(board: &Board, query: &str) -> anyhow::Result<CardId> {
    board.find(query)
}

/// Apply `change` to the card `id` names and answer whether it changed.
async fn change_card(
    state: &AppState,
    id: String,
    change: impl FnOnce(&mut Board, &CardId, Timestamp) -> anyhow::Result<bool> + Send + 'static,
) -> Response {
    let inputs = match inputs(state).await {
        Ok(inputs) => inputs,
        Err(refusal) => return refusal.into_response(),
    };
    blocking(move || {
        let store = inputs.settings.store.clone();
        let card = store
            .load()
            .and_then(|board| find(&board, &id))
            .map_err(|e| refusal(StatusCode::NOT_FOUND, &e))?;
        let changed = store
            .update(|board| change(board, &card, Timestamp::now()))
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        Ok(ChangeAnswer { changed })
    })
    .await
}

#[derive(Serialize)]
struct ChangeAnswer {
    /// `false` when the card already was that way.
    changed: bool,
}

async fn resolve_card(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    change_card(&state, id, |board, card, now| {
        board.resolve(card, Some(RESOLVED_BY), None, now)
    })
    .await
}

async fn reopen_card(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    change_card(&state, id, |board, card, now| board.reopen(card, now)).await
}

#[derive(Deserialize)]
struct AssignBody {
    /// One of `[board] people`; absent, or "anyone", for nobody's in particular.
    #[serde(default)]
    person: Option<String>,
}

/// Hand a card to a person's queue. Only an open task can be handed over, on a
/// board with people, as in the terminal UI: news, validations and
/// confirmations stay with whoever they were posted for.
async fn assign_card(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<AssignBody>,
) -> Response {
    let inputs = match inputs(&state).await {
        Ok(inputs) => inputs,
        Err(refusal) => return refusal.into_response(),
    };
    blocking(move || {
        let settings = &inputs.settings;
        if !settings.has_people() {
            return Err((
                StatusCode::CONFLICT,
                "This board has no queues to hand cards to: list the people in [board] people."
                    .to_string(),
            ));
        }
        let person = settings
            .person(body.person.as_deref().unwrap_or("anyone"))
            .map_err(|e| refusal(StatusCode::BAD_REQUEST, &e))?;
        let board = settings
            .store
            .load()
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        let card_id = find(&board, &id).map_err(|e| refusal(StatusCode::NOT_FOUND, &e))?;
        let assignable = board
            .card(&card_id)
            .is_some_and(|card| card.is_open() && card.kind == CardKind::Task);
        if !assignable {
            return Err((
                StatusCode::CONFLICT,
                format!(
                    "Only an open task can be handed to another queue; card #{card_id} stays \
                     with whoever it was posted for."
                ),
            ));
        }
        let changed = settings
            .store
            .update(|board| {
                board.assign(
                    &card_id,
                    person.as_deref(),
                    settings.me.as_deref(),
                    Timestamp::now(),
                )
            })
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        Ok(ChangeAnswer { changed })
    })
    .await
}

#[derive(Deserialize)]
struct PriorityBody {
    priority: String,
}

async fn set_priority(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PriorityBody>,
) -> Response {
    let Some(priority) = Priority::parse(&body.priority) else {
        return (
            StatusCode::BAD_REQUEST,
            "a priority is one of critical, high, normal or low",
        )
            .into_response();
    };
    change_card(&state, id, move |board, card, now| {
        board.set_priority(card, priority, now)
    })
    .await
}

#[derive(Deserialize)]
struct ReplyBody {
    text: String,
    /// Mark the card done with the reply.
    #[serde(default)]
    done: bool,
}

#[derive(Serialize)]
struct ReplyAnswer {
    /// The agent the reply was sent to, by label; `None` when it only joined
    /// the card's conversation.
    sent_to: Option<String>,
}

async fn reply_card(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<ReplyBody>,
) -> Response {
    if body.text.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "a reply needs some text").into_response();
    }
    let inputs = match inputs(&state).await {
        Ok(inputs) => inputs,
        Err(refusal) => return refusal.into_response(),
    };
    blocking(move || {
        let store = inputs.settings.store.clone();
        let board = store
            .load()
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        let card_id = find(&board, &id).map_err(|e| refusal(StatusCode::NOT_FOUND, &e))?;
        let card = board.card(&card_id).cloned().ok_or_else(|| {
            refusal(
                StatusCode::NOT_FOUND,
                &anyhow::anyhow!("there is no card #{id} on the board"),
            )
        })?;
        let sent_to = match inputs.poster_here(&card) {
            Some((handle, label)) => {
                send_to_agent(&inputs, &card, handle, &body.text)
                    .map_err(|e| refusal(StatusCode::BAD_GATEWAY, &e))?;
                Some(label.clone())
            }
            None => None,
        };
        let message = NewMessage {
            from: inputs.writer(),
            side: inputs.settings.me.clone(),
            text: body.text,
            done: body.done,
        };
        store
            .update(|board| {
                let now = Timestamp::now();
                let stored = board.reply(&card_id, &message, now)?;
                if sent_to.is_some() {
                    board.mark_relayed(&card_id, (stored.at, &stored.from, &stored.text), now)?;
                }
                Ok(())
            })
            .map_err(|e| refusal(StatusCode::INTERNAL_SERVER_ERROR, &e))?;
        Ok(ReplyAnswer { sent_to })
    })
    .await
}

/// Send `reply` to the agent `handle` that posted `card`, in the words the
/// terminal UI would type into it.
fn send_to_agent(
    inputs: &BoardInputs,
    card: &Card,
    handle: &str,
    reply: &str,
) -> anyhow::Result<()> {
    let Some(exe) = inputs.exe.as_deref() else {
        anyhow::bail!("yaran cannot tell where it was started from, so it cannot send the reply");
    };
    let writer = inputs.writer();
    let job = RelayJob {
        card: card.id.clone(),
        to: handle.to_string(),
        sender: yaran_core::sanitize::amq_handle(&writer),
        person: writer,
        text: render_reply(&inputs.reply_template, card, reply),
        card_itself: false,
        // Nothing to record yet: the reply joins the card once it is sent.
        messages: Vec::new(),
    };
    relay::deliver(
        &job,
        &inputs.settings.relay_transport,
        exe,
        &inputs.settings.store,
    )
}

#[cfg(test)]
#[path = "board_routes_tests.rs"]
mod tests;
