//! The cloud leg's web surface: `POST /api/v1/server/cloud-mode` (save `[cloud] mode`,
//! then move the tunnel), `GET /api/v1/cloud/leg` (the view snapshot, no remote call),
//! and the `cloud.changed` resource event on `/ws/events` (delivered on the `config`
//! topic; Phase 13 refetches on it).
//!
//! - The mode route mirrors the Tailscale one: config write first so the choice survives
//!   whatever happens to the tunnel, then the lane, then one sentence with its chips.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_mode_routes.rs
//! ├── cloud_mode
//! ├── event_bus
//! ├── rest_common
//! ├── server
//! ├── test_support
//! ├── yaran-core::cloud::leg_identity
//! ├── yaran-core::cloud::leg_outcome
//! ├── yaran-core::cloud::view
//! ├── yaran-core::prose
//! └── yaran-core::wire
//! External: axum, serde, serde_json, std, tokio, tower
//!
//! Used by:
//! cloud_mode_routes.rs
//! ├── crate
//! └── server
//! <module-headers:end>

use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use yaran_core::cloud::leg_identity::CloudMode;
use yaran_core::cloud::leg_outcome::CloudModeOutcome;
use yaran_core::cloud::view::{CloudLegState, CloudLegView};
use yaran_core::wire::WireCommand;

use crate::event_bus::{Event, EventBus};
use crate::rest_common::scope_from_headers;
use crate::server::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/server/cloud-mode", post(set_cloud_mode))
        .route("/api/v1/cloud/leg", get(get_cloud_leg))
}

#[derive(Deserialize)]
struct CloudModeBody {
    /// One of `auto` | `yes` | `no`; the engine refuses anything else.
    mode: String,
}

#[derive(Serialize)]
struct CloudModeReply {
    mode: String,
    warning: bool,
    sticky: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<yaran_core::prose::ProseSegment>>,
}

async fn set_cloud_mode(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CloudModeBody>,
) -> Response {
    if let Err(e) = state
        .engine
        .apply_wire_scoped(
            WireCommand::SetCloudMode {
                mode: body.mode.clone(),
            },
            scope_from_headers(&headers, &state.connections),
        )
        .await
    {
        return (StatusCode::BAD_REQUEST, e).into_response();
    }
    let mode = CloudMode::parse(&body.mode).unwrap_or_default();
    let outcome = match state.cloud.as_ref() {
        Some(control) => control.set_mode(mode).await,
        None => CloudModeOutcome::NotServing,
    };
    let report = outcome.report(mode);
    let (message, segments) = report.message.into_parts();
    Json(CloudModeReply {
        mode: mode.as_str().to_string(),
        warning: report.warning,
        sticky: report.sticky,
        message,
        segments,
    })
    .into_response()
}

async fn get_cloud_leg(State(state): State<AppState>) -> Json<CloudLegView> {
    Json(match state.cloud.as_ref() {
        Some(control) => control.view(),
        None => CloudLegView {
            state: CloudLegState::NotServing,
            ..CloudLegView::default()
        },
    })
}

/// The payload-less `cloud.changed` signal.
pub(crate) fn cloud_changed_event() -> Event {
    Event::Resource {
        event: "cloud.changed".to_string(),
        id: None,
        rev: None,
        owner: None,
        epoch: None,
        device: None,
    }
}

/// Bridge the cloud loop's view changes onto the event bus. Exits with the serve.
pub(crate) fn spawn_cloud_changed_forwarder(
    control: Option<&crate::cloud_mode::CloudModeControl>,
    bus: Arc<EventBus>,
) {
    let Some(control) = control else {
        return;
    };
    let mut changes = control.subscribe_changes();
    tokio::spawn(async move {
        while let Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) =
            changes.recv().await
        {
            bus.emit(cloud_changed_event());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        body: &str,
    ) -> (StatusCode, serde_json::Value) {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    #[tokio::test]
    async fn the_leg_route_answers_not_serving_without_a_serve() {
        let (_tmp, app) = crate::test_support::router_no_auth();
        let (status, body) = call(&app, "GET", "/api/v1/cloud/leg", "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["state"], "not_serving");
    }

    #[tokio::test]
    async fn the_mode_route_refuses_garbage_and_answers_auto() {
        let (_tmp, app) = crate::test_support::router_no_auth();
        let (status, _) = call(
            &app,
            "POST",
            "/api/v1/server/cloud-mode",
            r#"{"mode":"sometimes"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, body) = call(
            &app,
            "POST",
            "/api/v1/server/cloud-mode",
            r#"{"mode":"auto"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["mode"], "auto");
        assert!(
            body["message"]
                .as_str()
                .unwrap()
                .contains("Nothing is serving")
        );
    }

    #[test]
    fn the_event_is_payload_less() {
        let Event::Resource { event, id, .. } = cloud_changed_event();
        assert_eq!((event.as_str(), id), ("cloud.changed", None));
    }
}
