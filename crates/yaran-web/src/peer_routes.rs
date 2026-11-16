//! `POST /api/v1/peer/sync`: reconcile the shared AMQ registry from this
//! yaran's sessions and answer the sessions a peer message can reach.
//! `GET /api/v1/peer/sessions`: those sessions alone, with no registry pass,
//! for `yaran board` recognising the agent it runs in.
//!
//! `yaran peer` is a command-line client, and only the process holding
//! `dux.lock` opens `sessions.sqlite3`, so the command asks the running yaran
//! for this instead of reading the database behind its back. A POST because
//! the registry pass writes: it reserves inboxes and deconflicts handles.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};

use crate::server::AppState;

/// The peer route.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/peer/sync", post(sync_peers))
        .route("/api/v1/peer/sessions", get(list_peers))
}

async fn list_peers(State(state): State<AppState>) -> Response {
    let paths = state.engine.paths();
    answer(
        tokio::task::spawn_blocking(move || yaran_core::peer::routable_sessions(paths.as_ref()))
            .await,
    )
}

async fn sync_peers(State(state): State<AppState>) -> Response {
    let paths = state.engine.paths();
    // The registry pass and the database read block, so they run off the reactor.
    answer(
        tokio::task::spawn_blocking(move || yaran_core::peer::sync_and_list(paths.as_ref())).await,
    )
}

/// The JSON of what a blocking peer read answered, or why it did not.
fn answer<T: serde::Serialize>(ran: Result<anyhow::Result<T>, tokio::task::JoinError>) -> Response {
    match ran {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            yaran_core::sanitize::for_terminal(&format!("{error:#}")),
        )
            .into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the peer request stopped before it answered: {error}"),
        )
            .into_response(),
    }
}
