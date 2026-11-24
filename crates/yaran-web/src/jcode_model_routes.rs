//! The two UIs share jcode target selection and model changes in yaran-core.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use yaran_core::jcode_models::change_models;

use crate::server::AppState;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/api/v1/jcode/models", get(targets).post(change))
}

async fn targets(State(state): State<AppState>) -> Response {
    match state.engine.jcode_model_targets().await {
        Some(targets) => Json(targets).into_response(),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            "The Yaran engine is unavailable.",
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct ChangeBody {
    tab_ids: Vec<String>,
    model: String,
}

async fn change(State(state): State<AppState>, Json(body): Json<ChangeBody>) -> Response {
    let Some(targets) = state.engine.jcode_model_targets().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The Yaran engine is unavailable.",
        )
            .into_response();
    };
    match tokio::task::spawn_blocking(move || change_models(&targets, &body.tab_ids, &body.model))
        .await
    {
        Ok(Ok(outcomes)) => Json(outcomes).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "The model change worker failed. Check the model in jcode before retrying.",
        )
            .into_response(),
    }
}
