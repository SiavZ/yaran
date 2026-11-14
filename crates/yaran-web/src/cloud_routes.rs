//! Yaran Cloud over HTTP: the routes behind the web app menu's "Yaran Cloud…" dialog.
//!
//! The dialog shows the pairing status and offers Connect, Rotate token and
//! Disconnect. Every action is the engine-free `yaran_core::cloud` function the CLI
//! and the TUI run, so the outcome sentence is the same on every surface; this file
//! only adapts it to HTTP and to the keyed status lane.
//!
//! - The server never opens a browser: Connect answers the authorize URL and the page
//!   opens it from its own click handler, because the browser may not be on this
//!   machine. A remote browser pastes its landing address to `login/complete`.
//! - One login at a time: a new start cancels the old one, whose final is then
//!   dropped so it cannot overwrite the new login's spinner.
//! - Blocking work (credentials file, control-plane calls) runs in `spawn_blocking`
//!   or on the login's own thread; the async handlers only wait.
//! - Every action posts a keyed Busy (its key registered as live) and then the
//!   outcome's own final on the same key through `EngineHandle::post_status`.
//! - No secret ever leaves: the status body is `cloud::status::StatusReport`, which
//!   carries none.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_routes.rs
//! ├── cloud_routes::actions_routes
//! ├── cloud_routes::tests
//! ├── engine_actor
//! ├── rest_common
//! ├── server
//! ├── yaran-core::cloud::config
//! ├── yaran-core::cloud::login
//! ├── yaran-core::cloud::login_session
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::status
//! ├── yaran-core::engine
//! ├── yaran-core::logger
//! └── yaran-core::statusline
//! External: axum, serde, std, tokio, uuid
//!
//! Used by:
//! cloud_routes.rs
//! ├── cloud_routes::actions_routes
//! ├── cloud_routes::tests
//! ├── crate
//! ├── engine_actor
//! └── server
//! <module-headers:end>

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};

use yaran_core::cloud::config::CloudConfig;
use yaran_core::cloud::login::{LoginParams, LoginStep};
use yaran_core::cloud::login_session::{AuthorizeInfo, LoginEvent, LoginHandle, spawn_login};
use yaran_core::cloud::machine_api::{ApiFactory, default_api_factory};
use yaran_core::cloud::outcome::{CloudActionOutcome, KEY_LOGIN, KEY_STATUS};
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::status::{StatusReport, gather};
use yaran_core::engine::{Engine, StatusUpdate};
use yaran_core::statusline::{LiveStatusKeys, StatusTone};

use crate::engine_actor::EngineHandle;
use crate::rest_common::RouteRejection;
use crate::server::AppState;

/// What the routes read from the engine per request: instant clones, so a config
/// reload is seen by the next request.
#[derive(Clone)]
pub struct CloudInputs {
    pub paths: CloudPaths,
    pub cloud: CloudConfig,
    /// The effective serving port, sent to the control plane as `origin_port`.
    pub server_port: u16,
    pub live_keys: LiveStatusKeys,
}

impl CloudInputs {
    pub(crate) fn from_engine(engine: &Engine) -> Self {
        Self {
            paths: CloudPaths::new(&engine.paths),
            cloud: engine.config.cloud.clone(),
            server_port: engine.config.server.port,
            live_keys: engine.live_status_keys.clone(),
        }
    }

    fn request_timeout(&self) -> Duration {
        Duration::from_secs(self.cloud.request_timeout_seconds.max(1))
    }
}

/// The running login, if any.
struct ActiveLogin {
    id: String,
    handle: LoginHandle,
    /// Filled when the login reaches its authorize step, so a reopened dialog can
    /// show the same URL and fingerprint again.
    info: Option<AuthorizeInfo>,
    /// Every event the login thread reports, for `login/complete` to wait on.
    events: broadcast::Sender<LoginEvent>,
}

/// The routes' own state: the engine, an optional control-plane client override
/// (tests point it at a mock Worker), and the one login slot.
pub struct CloudState {
    engine: EngineHandle,
    api: Option<ApiFactory>,
    login: Arc<Mutex<Option<ActiveLogin>>>,
}

impl CloudState {
    pub fn new(engine: EngineHandle, api: Option<ApiFactory>) -> Arc<Self> {
        Arc::new(Self {
            engine,
            api,
            login: Arc::new(Mutex::new(None)),
        })
    }

    fn api_for(&self, inputs: &CloudInputs) -> ApiFactory {
        self.api
            .clone()
            .unwrap_or_else(|| default_api_factory(inputs.request_timeout()))
    }

    async fn inputs(&self) -> Result<CloudInputs, RouteRejection> {
        self.engine.cloud_inputs().await.ok_or_else(|| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "the engine is unavailable; retry shortly",
            )
                .into_response()
                .into()
        })
    }

    /// Show a spinner on `key`, registered as live so a slow call is not called stranded.
    fn busy(&self, inputs: &CloudInputs, key: &str, message: &str) {
        inputs.live_keys.register(key);
        self.engine
            .post_status(StatusUpdate::keyed(key, StatusTone::Busy, message));
    }
}

fn lock(slot: &Mutex<Option<ActiveLogin>>) -> MutexGuard<'_, Option<ActiveLogin>> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The production routes, merged into the main router by `server::build_app`.
pub fn routes(state: &AppState) -> Router<AppState> {
    router(CloudState::new(state.engine.clone(), None))
}

/// The routes over an explicit state, for tests that inject a mock control plane.
pub fn router<S: Clone + Send + Sync + 'static>(cloud: Arc<CloudState>) -> Router<S> {
    Router::new()
        .route("/api/v1/cloud/status", get(get_status))
        .route("/api/v1/cloud/login/start", post(login_start))
        .route("/api/v1/cloud/login/complete", post(login_complete))
        .route("/api/v1/cloud/login/cancel", post(login_cancel))
        .route("/api/v1/cloud/logout", post(actions_routes::logout))
        .route("/api/v1/cloud/rotate", post(actions_routes::rotate))
        .with_state(cloud)
}

/// The authorize step of a login, as the dialog shows it.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LoginView {
    pub login_id: String,
    pub authorize_url: String,
    pub fingerprint: String,
    pub org_name: String,
}

impl LoginView {
    fn new(login_id: &str, info: &AuthorizeInfo) -> Self {
        Self {
            login_id: login_id.to_string(),
            authorize_url: info.url.clone(),
            fingerprint: info.fingerprint.clone(),
            org_name: info.org_name.clone(),
        }
    }
}

#[derive(Serialize)]
struct StatusBody {
    #[serde(flatten)]
    report: StatusReport,
    /// `[cloud] org_url`, the default for the Connect field (empty: type it).
    default_org_url: String,
    /// The login waiting on a browser, so a reopened dialog resumes it.
    active_login: Option<LoginView>,
}

async fn get_status(State(cloud): State<Arc<CloudState>>) -> Response {
    let inputs = match cloud.inputs().await {
        Ok(i) => i,
        Err(r) => return r.into_response(),
    };
    let (paths, mode) = (inputs.paths.clone(), inputs.cloud.mode());
    let report = match tokio::task::spawn_blocking(move || gather(&paths, mode, None)).await {
        Ok(r) => r,
        Err(e) => return worker_died(KEY_STATUS, &e),
    };
    let active_login = lock(&cloud.login)
        .as_ref()
        .and_then(|a| a.info.as_ref().map(|info| LoginView::new(&a.id, info)));
    Json(StatusBody {
        report,
        default_org_url: inputs.cloud.org_url.clone(),
        active_login,
    })
    .into_response()
}

#[derive(Deserialize)]
struct StartBody {
    org_url: String,
}

async fn login_start(
    State(cloud): State<Arc<CloudState>>,
    Json(body): Json<StartBody>,
) -> Response {
    let inputs = match cloud.inputs().await {
        Ok(i) => i,
        Err(r) => return r.into_response(),
    };
    let id = uuid::Uuid::new_v4().to_string();
    let (ready_tx, ready_rx) = oneshot::channel();
    let (events, _) = broadcast::channel(32);
    cloud.busy(
        &inputs,
        KEY_LOGIN,
        "Connecting this machine to Yaran Cloud: approve it in the browser tab that opens, \
         or paste the address the browser lands on into the dialog.",
    );
    let params = LoginParams {
        org_url: body.org_url,
        machine_name: None,
        origin_port: inputs.server_port,
        timeout: Duration::from_secs(inputs.cloud.login_timeout_seconds.max(1)),
        paths: inputs.paths.clone(),
        api: cloud.api_for(&inputs),
    };
    let on_event = login_event_sink(&cloud, id.clone(), events.clone(), ready_tx);
    {
        // Held across the spawn so the new login's callbacks wait until it is
        // the current one; the old one is cancelled and its final dropped.
        let mut slot = lock(&cloud.login);
        if let Some(old) = slot.take() {
            old.handle.cancel();
        }
        let handle = spawn_login(params, on_event);
        *slot = Some(ActiveLogin {
            id: id.clone(),
            handle,
            info: None,
            events,
        });
    }
    match ready_rx.await {
        Ok(Ok(info)) => Json(LoginView::new(&id, &info)).into_response(),
        Ok(Err(outcome)) => refusal(&outcome),
        Err(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the login stopped without saying why; see yaran.log",
        )
            .into_response(),
    }
}

type Ready = oneshot::Sender<Result<AuthorizeInfo, CloudActionOutcome>>;

/// The login thread's callback: records the authorize step, answers the waiting
/// start request, and posts the final only while this login is still the current one.
fn login_event_sink(
    cloud: &Arc<CloudState>,
    id: String,
    events: broadcast::Sender<LoginEvent>,
    ready: Ready,
) -> impl FnMut(LoginEvent) + Send + 'static {
    let slot = Arc::clone(&cloud.login);
    let engine = cloud.engine.clone();
    let mut ready = Some(ready);
    move |event| {
        let _ = events.send(event.clone());
        match event {
            LoginEvent::Authorize(info) => {
                if let Some(active) = lock(&slot).as_mut().filter(|a| a.id == id) {
                    active.info = Some(info.clone());
                }
                if let Some(tx) = ready.take() {
                    let _ = tx.send(Ok(info));
                }
            }
            LoginEvent::Step(_) => {}
            LoginEvent::Finished(outcome) => {
                let current = {
                    let mut guard = lock(&slot);
                    let current = guard.as_ref().is_some_and(|a| a.id == id);
                    if current {
                        *guard = None;
                    }
                    current
                };
                if current {
                    engine.post_status(outcome.to_status(KEY_LOGIN));
                }
                if let Some(tx) = ready.take() {
                    let _ = tx.send(Err(outcome));
                }
            }
        }
    }
}

#[derive(Deserialize)]
struct CompleteBody {
    login_id: String,
    callback_url: String,
}

/// What `login/complete` answers when the paste was accepted.
#[derive(Serialize)]
struct CompleteReply {
    /// `false` when the claim was still running at the wait's end; the keyed
    /// toast reports the outcome either way.
    finished: bool,
}

async fn login_complete(
    State(cloud): State<Arc<CloudState>>,
    Json(body): Json<CompleteBody>,
) -> Response {
    let inputs = match cloud.inputs().await {
        Ok(i) => i,
        Err(r) => return r.into_response(),
    };
    let (handle, mut rx) = match lock(&cloud.login)
        .as_ref()
        .filter(|a| a.id == body.login_id)
    {
        Some(active) => (active.handle.clone(), active.events.subscribe()),
        None => return login_gone(),
    };
    handle.paste(body.callback_url);
    // Parsing the paste is instant; the claim after it is one control-plane request.
    let wait = inputs.request_timeout() * 2;
    let answer = tokio::time::timeout(wait, async move {
        loop {
            match rx.recv().await {
                Ok(LoginEvent::Step(LoginStep::PasteRejected { reason })) => return Err(reason),
                Ok(LoginEvent::Finished(outcome)) => return Ok(Some(outcome)),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return Ok(None),
            }
        }
    })
    .await;
    match answer {
        Ok(Err(reason)) => (StatusCode::UNPROCESSABLE_ENTITY, reason).into_response(),
        Ok(Ok(Some(outcome))) if outcome.is_failure() => refusal(&outcome),
        Ok(Ok(Some(_))) => Json(CompleteReply { finished: true }).into_response(),
        Ok(Ok(None)) | Err(_) => (
            StatusCode::ACCEPTED,
            Json(CompleteReply { finished: false }),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct CancelBody {
    login_id: String,
}

/// Cancel the named login. The slot is cleared and the `LoginCancelled` final
/// posted here, so the next status read already shows no login; the thread's own
/// final is then dropped as stale. A login that already ended is a no-op.
async fn login_cancel(
    State(cloud): State<Arc<CloudState>>,
    Json(body): Json<CancelBody>,
) -> Response {
    let cancelled = {
        let mut slot = lock(&cloud.login);
        match slot.take() {
            Some(active) if active.id == body.login_id => Some(active),
            other => {
                *slot = other;
                None
            }
        }
    };
    if let Some(active) = cancelled {
        active.handle.cancel();
        cloud
            .engine
            .post_status(CloudActionOutcome::LoginCancelled.to_status(KEY_LOGIN));
    }
    StatusCode::NO_CONTENT.into_response()
}

/// A login that ended before (or instead of) succeeding: the outcome's own sentence.
fn refusal(outcome: &CloudActionOutcome) -> Response {
    (
        StatusCode::UNPROCESSABLE_ENTITY,
        outcome.report().message().to_string(),
    )
        .into_response()
}

fn login_gone() -> Response {
    (
        StatusCode::CONFLICT,
        "That Yaran Cloud login is no longer running (it finished, timed out, or a newer one \
         replaced it); start a new one.",
    )
        .into_response()
}

/// A blocking task panicked (the caller posts the keyed final if it showed a spinner).
fn worker_died(key: &str, err: &tokio::task::JoinError) -> Response {
    yaran_core::logger::error(&format!("cloud route worker for {key} failed: {err}"));
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "the Yaran Cloud worker failed; see yaran.log",
    )
        .into_response()
}

#[path = "cloud_routes_actions.rs"]
mod actions_routes;

#[cfg(test)]
#[path = "cloud_routes_tests.rs"]
mod tests;
