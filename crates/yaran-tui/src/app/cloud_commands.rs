//! Yaran Cloud palette commands: the modals' state, their keys and mouse, and the workers.
//!
//! `cloud-login`, `cloud-logout`, `cloud-rotate-token`, `cloud-status` and
//! `cloud-pair-phone` are always listed: a worker answers "not paired" or "already
//! paired elsewhere" rather than the palette guessing from a file stat. Every sentence
//! a result shows comes from `yaran_core::cloud::outcome`, so the CLI, this surface and
//! the web read the same words.
//!
//! - One `PromptState::Cloud` variant whose modal family follows its stage (`modal.rs`).
//! - The login thread, logout, rotate, status and the QR all run off the UI thread and
//!   answer through `CloudState`'s channel, drained once per tick.
//! - Each action shows a keyed busy and replaces it with its outcome under the same key.
//! - Escape on a running login cancels it, which also closes its loopback listener.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_commands.rs
//! ├── app
//! ├── yaran-core::cloud::actions
//! ├── yaran-core::cloud::credentials
//! ├── yaran-core::cloud::login
//! ├── yaran-core::cloud::login_session
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::org_url
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::qr
//! ├── yaran-core::cloud::status
//! ├── yaran-core::engine
//! ├── yaran-core::prose
//! └── yaran-core::status_text
//! External: std
//!
//! Used by:
//! app/cloud_commands.rs
//! ├── app
//! ├── app::cloud_input
//! ├── app::cloud_render
//! ├── app::cloud_tests
//! ├── app::modal
//! └── app::overlay_dismiss
//! <module-headers:end>

use std::time::Duration;

use yaran_core::cloud::actions::{logout, rotate_token};
use yaran_core::cloud::login::{LoginParams, LoginStep};
use yaran_core::cloud::login_session::{AuthorizeInfo, LoginEvent, LoginHandle, spawn_login};
use yaran_core::cloud::machine_api::{ApiFactory, default_api_factory};
use yaran_core::cloud::outcome::{
    CloudActionOutcome, KEY_LOGIN, KEY_LOGOUT, KEY_ROTATE, KEY_STATUS,
};
use yaran_core::cloud::paths::CloudPaths;
use yaran_core::cloud::qr::Qr;
use yaran_core::cloud::status::{StatusReport, gather};
use yaran_core::cloud::{credentials, org_url::normalize_org_url};
use yaran_core::engine::{EventReaction, StatusUpdate};
use yaran_core::prose::Prose;
use yaran_core::status_text;
use yaran_core::status_text::StatusText;

use super::*;

/// The pair-phone busy's key: a local read with no outcome sentence of its own.
pub(crate) const KEY_PAIR_PHONE: &str = "cloud-pair-phone";

/// A keyed busy (core keeps `StatusUpdate::busy` crate-private).
fn cloud_busy(key: &str, text: impl Into<StatusText>) -> StatusUpdate {
    StatusUpdate::keyed(key, StatusTone::Busy, text)
}

/// Which Yaran Cloud modal is open, and where it is.
#[derive(Clone, Debug)]
pub(crate) enum CloudPrompt {
    /// Form: the org address, then (once the login runs) the pasted landing address.
    Login(Box<CloudLogin>),
    /// Confirm: disconnect this machine. Opens on Cancel.
    Logout(ConfirmFocus),
    /// Confirm: rotate the tunnel token. Opens on Cancel.
    Rotate(ConfirmFocus),
    /// Report: `None` while the worker gathers.
    Status(Option<Box<StatusReport>>),
    /// Report: `None` while the worker builds the code.
    PairPhone(Option<Result<PhoneQr, Prose>>),
}

#[derive(Clone, Debug)]
pub(crate) struct CloudLogin {
    pub(crate) org_url: TextInput,
    /// Set once the login thread runs; its field replaces the address field.
    pub(crate) waiting: Option<CloudLoginWaiting>,
}

#[derive(Clone, Debug)]
pub(crate) struct CloudLoginWaiting {
    pub(crate) org_url: String,
    pub(crate) authorize: Option<AuthorizeInfo>,
    pub(crate) paste: TextInput,
    /// The last thing the login said about a pasted address.
    pub(crate) note: Option<String>,
}

impl CloudLogin {
    /// The one field the modal shows right now.
    pub(crate) fn field(&self) -> &TextInput {
        self.waiting.as_ref().map_or(&self.org_url, |w| &w.paste)
    }

    pub(crate) fn field_mut(&mut self) -> &mut TextInput {
        match &mut self.waiting {
            Some(waiting) => &mut waiting.paste,
            None => &mut self.org_url,
        }
    }
}

impl CloudPrompt {
    /// A paste lands in the login's field; the other modals hold no text.
    pub(crate) fn paste(&mut self, text: &str) {
        if let CloudPrompt::Login(login) = self {
            login.field_mut().insert_str(text.trim());
        }
    }
}

/// The add-org QR, as plain data so the prompt stays `Clone`.
#[derive(Clone, Debug)]
pub(crate) struct PhoneQr {
    pub(crate) org_url: String,
    pub(crate) uri: String,
    /// `modules[y][x]` from `Qr::is_dark`, quiet zone included.
    pub(crate) modules: Vec<Vec<bool>>,
}

/// What a worker or the login thread sends back.
pub(crate) enum CloudAnswer {
    Login(LoginEvent),
    Action {
        key: &'static str,
        outcome: CloudActionOutcome,
    },
    Status(Box<StatusReport>),
    PairPhone(Result<PhoneQr, Prose>),
}

pub(crate) struct CloudState {
    tx: mpsc::Sender<CloudAnswer>,
    rx: mpsc::Receiver<CloudAnswer>,
    /// The running login, kept until its `Finished` arrives (a cancel included).
    pub(crate) login: Option<LoginHandle>,
    /// Test seam: the control-plane client. `None` builds the production one.
    pub(crate) api: Option<ApiFactory>,
    /// The confirm button a mouse press armed; the release on it acts.
    pub(crate) pressed: Option<ConfirmFocus>,
}

impl Default for CloudState {
    fn default() -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            tx,
            rx,
            login: None,
            api: None,
            pressed: None,
        }
    }
}

impl App {
    /// The five palette commands' one entry point.
    pub(crate) fn run_cloud_command(&mut self, name: &str) {
        match name {
            "cloud-login" => self.open_cloud_login(),
            "cloud-logout" => {
                self.prompt = PromptState::Cloud(CloudPrompt::Logout(ConfirmFocus::Cancel));
            }
            "cloud-rotate-token" => {
                self.prompt = PromptState::Cloud(CloudPrompt::Rotate(ConfirmFocus::Cancel));
            }
            "cloud-status" => self.open_cloud_status(),
            "cloud-pair-phone" => self.open_cloud_pair_phone(),
            other => self.set_error(format!("{other} is not a Yaran Cloud command.")),
        }
    }

    fn cloud_paths(&self) -> CloudPaths {
        CloudPaths::new(&self.engine.paths)
    }

    fn cloud_api(&self) -> ApiFactory {
        self.cloud.api.clone().unwrap_or_else(|| {
            default_api_factory(Duration::from_secs(
                self.engine.config.cloud.request_timeout_seconds,
            ))
        })
    }

    fn open_cloud_login(&mut self) {
        if self.cloud.login.is_some() {
            self.set_warning(
                "A Yaran Cloud login is still finishing; wait for its result on the status line, \
                 then run cloud-login again.",
            );
            return;
        }
        let org_url = TextInput::with_text(self.engine.config.cloud.org_url.clone());
        self.prompt = PromptState::Cloud(CloudPrompt::Login(Box::new(CloudLogin {
            org_url,
            waiting: None,
        })));
    }

    fn open_cloud_status(&mut self) {
        self.prompt = PromptState::Cloud(CloudPrompt::Status(None));
        let (paths, api) = (self.cloud_paths(), self.cloud_api());
        let mode = self.engine.config.cloud.mode();
        self.spawn_cloud_worker(
            KEY_STATUS,
            "Checking this machine's Yaran Cloud pairing...",
            move || CloudAnswer::Status(Box::new(gather(&paths, mode, Some(&api)))),
        );
    }

    fn open_cloud_pair_phone(&mut self) {
        self.prompt = PromptState::Cloud(CloudPrompt::PairPhone(None));
        let paths = self.cloud_paths();
        let configured = self.engine.config.cloud.org_url.clone();
        self.spawn_cloud_worker(
            KEY_PAIR_PHONE,
            "Preparing the QR code that adds your organization to the Yaran app...",
            move || CloudAnswer::PairPhone(phone_qr(&paths, &configured)),
        );
    }

    /// Show a keyed busy, then run `work` on its own thread; its answer arrives
    /// through the channel and replaces the busy under the same key.
    fn spawn_cloud_worker(
        &mut self,
        key: &'static str,
        busy: impl Into<StatusText>,
        work: impl FnOnce() -> CloudAnswer + Send + 'static,
    ) {
        self.engine.register_status_key(key);
        self.cloud_status(cloud_busy(key, busy));
        let tx = self.cloud.tx.clone();
        let spawned = thread::Builder::new()
            .name(format!("yaran-{key}"))
            .spawn(move || {
                let _ = tx.send(work());
            });
        if let Err(err) = spawned {
            self.cloud_status(
                StatusUpdate::error(format!("Could not start the Yaran Cloud worker: {err}."))
                    .with_key(key),
            );
        }
    }

    fn cloud_status(&mut self, update: StatusUpdate) {
        self.apply_reaction(EventReaction::Status(update));
    }

    /// Fold every answer that arrived since the last tick.
    pub(crate) fn drain_cloud(&mut self) {
        while let Ok(answer) = self.cloud.rx.try_recv() {
            self.mark_frame_dirty();
            self.apply_cloud_answer(answer);
        }
    }

    pub(crate) fn apply_cloud_answer(&mut self, answer: CloudAnswer) {
        match answer {
            CloudAnswer::Login(event) => self.apply_cloud_login_event(event),
            CloudAnswer::Action { key, outcome } => self.cloud_status(outcome.to_status(key)),
            CloudAnswer::Status(report) => {
                let outcome = if let Some(reason) = &report.error {
                    Some(CloudActionOutcome::CredentialsUnreadable {
                        reason: reason.clone(),
                    })
                } else if !report.paired {
                    Some(CloudActionOutcome::NotPaired)
                } else if report.is_revoked() {
                    Some(CloudActionOutcome::Revoked {
                        hostname: report.hostname.clone().unwrap_or_default(),
                    })
                } else {
                    None
                };
                // A paired, healthy machine needs no sentence: the open report says it.
                match outcome {
                    Some(outcome) => self.cloud_status(outcome.to_status(KEY_STATUS)),
                    None => self.apply_reaction(EventReaction::ClearStatus(KEY_STATUS.into())),
                }
                if let PromptState::Cloud(CloudPrompt::Status(slot)) = &mut self.prompt {
                    *slot = Some(report);
                }
            }
            CloudAnswer::PairPhone(result) => {
                match &result {
                    Ok(_) => self.apply_reaction(EventReaction::ClearStatus(KEY_PAIR_PHONE.into())),
                    Err(reason) => self.cloud_status(StatusUpdate::keyed(
                        KEY_PAIR_PHONE,
                        StatusTone::Warning,
                        reason.clone(),
                    )),
                }
                if let PromptState::Cloud(CloudPrompt::PairPhone(slot)) = &mut self.prompt {
                    *slot = Some(result);
                }
            }
        }
    }

    fn cloud_login_waiting(&mut self) -> Option<&mut CloudLoginWaiting> {
        match &mut self.prompt {
            PromptState::Cloud(CloudPrompt::Login(login)) => login.waiting.as_mut(),
            _ => None,
        }
    }

    fn apply_cloud_login_event(&mut self, event: LoginEvent) {
        let live = self.cloud.login.as_ref().is_some_and(|h| !h.is_cancelled());
        match event {
            LoginEvent::Finished(outcome) => {
                self.cloud.login = None;
                if self.cloud_login_waiting().is_some() {
                    self.prompt = PromptState::None;
                }
                self.cloud_status(outcome.to_status(KEY_LOGIN));
            }
            // A cancelled login's late progress changes nothing on screen.
            _ if !live => {}
            LoginEvent::Authorize(info) => {
                let url = info.url.clone();
                if let Some(waiting) = self.cloud_login_waiting() {
                    waiting.authorize = Some(info);
                }
                self.cloud_status(cloud_busy(
                    KEY_LOGIN,
                    "Waiting for you to approve this machine in the browser...",
                ));
                self.open_url_in_browser(
                    url,
                    "Opened the Yaran Cloud approval page in your browser; approve it there if \
                     the fingerprint matches the one yaran shows.",
                );
            }
            LoginEvent::Step(step) => {
                let busy: Option<StatusText> = match step {
                    LoginStep::CheckingOrg { org_url } => Some(status_text!(
                        "Checking that ",
                        q(org_url),
                        " is a Yaran Cloud organization..."
                    )),
                    LoginStep::Claiming => Some("Approved; finishing the pairing...".into()),
                    LoginStep::PasteRejected { reason } => {
                        if let Some(waiting) = self.cloud_login_waiting() {
                            waiting.note = Some(reason);
                        }
                        None
                    }
                    LoginStep::BrowserUnavailable { .. } | LoginStep::Waiting => None,
                };
                if let Some(busy) = busy {
                    self.cloud_status(cloud_busy(KEY_LOGIN, busy));
                }
            }
        }
    }

    /// Enter in the login: start it, or hand over a pasted landing address.
    pub(super) fn submit_cloud_login(&mut self) {
        let PromptState::Cloud(CloudPrompt::Login(login)) = &mut self.prompt else {
            return;
        };
        let typed = login.field().text.trim().to_string();
        if let Some(waiting) = &mut login.waiting {
            if typed.is_empty() {
                return;
            }
            if let Some(handle) = &self.cloud.login {
                handle.paste(typed);
            }
            waiting.paste.clear();
            waiting.note = Some("Checking the pasted address...".into());
            return;
        }
        if let Err(reason) = normalize_org_url(&typed) {
            self.set_warning(reason);
            return;
        }
        let params = LoginParams {
            org_url: typed.clone(),
            machine_name: None,
            origin_port: self.engine.config.server.port,
            timeout: Duration::from_secs(self.engine.config.cloud.login_timeout_seconds),
            paths: self.cloud_paths(),
            api: self.cloud_api(),
        };
        self.engine.register_status_key(KEY_LOGIN);
        self.cloud_status(cloud_busy(
            KEY_LOGIN,
            status_text!("Starting the Yaran Cloud login with ", q(&typed), "..."),
        ));
        let tx = self.cloud.tx.clone();
        self.cloud.login = Some(spawn_login(params, move |event| {
            let _ = tx.send(CloudAnswer::Login(event));
        }));
        if let PromptState::Cloud(CloudPrompt::Login(login)) = &mut self.prompt {
            login.waiting = Some(CloudLoginWaiting {
                org_url: typed,
                authorize: None,
                paste: TextInput::new(),
                note: None,
            });
        }
    }

    /// Close the open Yaran Cloud modal the way Escape does. A running login is
    /// cancelled, which also closes its loopback listener; its `LoginCancelled`
    /// outcome then replaces the busy.
    pub(crate) fn cancel_cloud_prompt(&mut self) {
        if self.cloud_login_waiting().is_some()
            && let Some(handle) = &self.cloud.login
        {
            handle.cancel();
        }
        self.cloud.pressed = None;
        self.prompt = PromptState::None;
    }

    /// Answer Disconnect / Rotate token. Cancel runs nothing.
    pub(super) fn resolve_cloud_confirm(&mut self, confirm: bool) {
        let rotate = matches!(self.prompt, PromptState::Cloud(CloudPrompt::Rotate(_)));
        self.cloud.pressed = None;
        self.prompt = PromptState::None;
        if !confirm {
            return;
        }
        let (paths, api) = (self.cloud_paths(), self.cloud_api());
        if rotate {
            self.spawn_cloud_worker(
                KEY_ROTATE,
                "Rotating this machine's Yaran Cloud tunnel token...",
                move || CloudAnswer::Action {
                    key: KEY_ROTATE,
                    outcome: rotate_token(&paths, &api),
                },
            );
        } else {
            self.spawn_cloud_worker(
                KEY_LOGOUT,
                "Disconnecting this machine from Yaran Cloud...",
                move || CloudAnswer::Action {
                    key: KEY_LOGOUT,
                    outcome: logout(&paths, &api, false),
                },
            );
        }
    }
}

/// The add-org code for the paired org, else `[cloud] org_url` (runs on a worker).
fn phone_qr(paths: &CloudPaths, configured: &str) -> Result<PhoneQr, Prose> {
    let raw = credentials::read(paths)
        .ok()
        .flatten()
        .map(|c| c.org_url)
        .unwrap_or_else(|| configured.to_string());
    if raw.trim().is_empty() {
        return Err(Prose::new()
            .text("This machine is not paired and no organization is set. Run ")
            .name("cloud-login")
            .text(" from the palette first, or set [cloud] org_url in config.toml."));
    }
    let org_url = normalize_org_url(&raw).map_err(|e| Prose::from(e.as_str()))?;
    let (uri, qr) = Qr::add_org(&org_url).map_err(|e| Prose::from(e.as_str()))?;
    let size = qr.size();
    let modules = (0..size)
        .map(|y| (0..size).map(|x| qr.is_dark(x, y)).collect())
        .collect();
    Ok(PhoneQr {
        org_url,
        uri,
        modules,
    })
}
