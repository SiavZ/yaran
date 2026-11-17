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
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};

use crate::server::AppState;

/// The peer route.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/peer/sync", post(sync_peers))
        .route("/api/v1/peer/sessions", get(list_peers))
        .route_layer(middleware::from_fn(control_socket_only))
}

async fn control_socket_only(request: Request, next: Next) -> Response {
    if !crate::auth::provenance::over_control_socket(&request) {
        return StatusCode::NOT_FOUND.into_response();
    }
    next.run(request).await
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, extract::ConnectInfo};
    use tower::ServiceExt;

    use crate::auth::Arrival;

    #[tokio::test]
    async fn peer_routes_are_only_available_over_the_control_socket() {
        let (_tmp, app) = crate::test_support::router_no_auth();
        for arrival in [
            None,
            Some(Arrival::Tcp {
                peer: "127.0.0.1:50000".parse().unwrap(),
                local: "127.0.0.1:3890".parse().unwrap(),
            }),
            Some(Arrival::Tcp {
                peer: "192.0.2.1:50000".parse().unwrap(),
                local: "192.0.2.2:3890".parse().unwrap(),
            }),
        ] {
            for (method, path) in [
                ("GET", "/api/v1/peer/sessions"),
                ("POST", "/api/v1/peer/sync"),
            ] {
                let mut request = Request::builder()
                    .method(method)
                    .uri(path)
                    .header("host", "localhost")
                    .header("origin", "http://localhost")
                    .body(Body::empty())
                    .unwrap();
                if let Some(arrival) = arrival {
                    request.extensions_mut().insert(ConnectInfo(arrival));
                }
                assert_eq!(
                    app.clone().oneshot(request).await.unwrap().status(),
                    StatusCode::NOT_FOUND,
                    "{method} {path} from {arrival:?}"
                );
            }
        }

        let mut request = Request::builder()
            .uri("/api/v1/peer/sessions")
            .body(Body::empty())
            .unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo(Arrival::Unix { uid: 1000 }));
        assert_eq!(app.oneshot(request).await.unwrap().status(), StatusCode::OK);
    }
}
