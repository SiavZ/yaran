//! The two UIs share jcode target selection and model changes in yaran-core.

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;
use std::collections::BTreeMap;
use yaran_core::jcode_models::{change_models, model_catalog};

use crate::server::AppState;

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/jcode/models", get(targets).post(change))
        .route("/api/v1/jcode/models/catalog", axum::routing::post(catalog))
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
    runs: BTreeMap<String, String>,
    bindings: BTreeMap<String, String>,
    choice_id: String,
    reasoning_effort: Option<String>,
}

async fn change(State(state): State<AppState>, Json(body): Json<ChangeBody>) -> Response {
    let Some(targets) = state.engine.jcode_model_targets().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The Yaran engine is unavailable.",
        )
            .into_response();
    };
    match tokio::task::spawn_blocking(move || {
        change_models(
            &targets,
            &body.runs,
            &body.bindings,
            &body.choice_id,
            body.reasoning_effort.as_deref(),
        )
    })
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

#[derive(Deserialize)]
struct CatalogBody {
    runs: BTreeMap<String, String>,
}

async fn catalog(State(state): State<AppState>, Json(body): Json<CatalogBody>) -> Response {
    let Some(targets) = state.engine.jcode_model_targets().await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The Yaran engine is unavailable.",
        )
            .into_response();
    };
    match tokio::task::spawn_blocking(move || model_catalog(&targets, &body.runs)).await {
        Ok(Ok(choices)) => Json(choices).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "The native model catalog worker failed.",
        )
            .into_response(),
    }
}
