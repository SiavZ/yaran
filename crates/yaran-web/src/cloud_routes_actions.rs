//! The confirmed Yaran Cloud actions over HTTP: `POST /api/v1/cloud/logout` and `/rotate`.
//!
//! A child of `cloud_routes`: each handler posts a keyed Busy, runs the shared
//! `yaran_core::cloud::actions` function in `spawn_blocking`, then posts the outcome's
//! final on the same key and answers its sentence.
//!
//! - The browser confirms first (its own dialog); these handlers do not ask again.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_routes_actions.rs
//! ├── cloud_routes
//! ├── yaran-core::cloud::actions
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::engine
//! └── yaran-core::statusline
//! External: axum, serde, std, tokio
//!
//! Used by:
//! cloud_routes_actions.rs
//! └── cloud_routes
//! <module-headers:end>

use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use yaran_core::cloud::actions;
use yaran_core::cloud::machine_api::ApiFactory;
use yaran_core::cloud::outcome::{CloudActionOutcome, KEY_LOGOUT, KEY_ROTATE};
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::engine::StatusUpdate;
use yaran_core::statusline::StatusTone;

use super::{CloudState, worker_died};

/// What `logout` and `rotate` answer; the keyed toast carries the sentence.
#[derive(Serialize)]
struct ActionReply {
    ok: bool,
    message: String,
}

pub(super) async fn logout(State(cloud): State<Arc<CloudState>>) -> Response {
    run_action(
        &cloud,
        KEY_LOGOUT,
        "Disconnecting this machine from Yaran Cloud and deleting its credentials…",
        |paths, api| actions::logout(paths, api, false),
    )
    .await
}

pub(super) async fn rotate(State(cloud): State<Arc<CloudState>>) -> Response {
    run_action(
        &cloud,
        KEY_ROTATE,
        "Rotating this machine's Yaran Cloud tunnel token…",
        actions::rotate_token,
    )
    .await
}

async fn run_action(
    cloud: &Arc<CloudState>,
    key: &'static str,
    busy: &str,
    action: fn(&CloudPaths, &ApiFactory) -> CloudActionOutcome,
) -> Response {
    let inputs = match cloud.inputs().await {
        Ok(i) => i,
        Err(r) => return r.into_response(),
    };
    cloud.busy(&inputs, key, busy);
    let (paths, api) = (inputs.paths.clone(), cloud.api_for(&inputs));
    let outcome = match tokio::task::spawn_blocking(move || action(&paths, &api)).await {
        Ok(o) => o,
        Err(e) => {
            cloud.engine.post_status(StatusUpdate::keyed(
                key,
                StatusTone::Error,
                "The Yaran Cloud action failed unexpectedly; see yaran.log for the details.",
            ));
            return worker_died(key, &e);
        }
    };
    cloud.engine.post_status(outcome.to_status(key));
    Json(ActionReply {
        ok: !outcome.is_failure(),
        message: outcome.report().message().to_string(),
    })
    .into_response()
}
