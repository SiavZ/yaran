//! A login running on its own thread, for front ends that cannot block (TUI, web).
//!
//! `spawn_login` runs `run_login` on a worker thread and reports through a callback:
//! first the authorize URL and fingerprint (`LoginEvent::Authorize`), then progress,
//! then exactly one `Finished` outcome. The front end opens the URL itself (the TUI
//! through its `UrlOpener` seam, the web from the page's click handler, since the
//! browser may not be on the server's machine), feeds pasted callback addresses with
//! `paste`, and stops it with `cancel` (Escape, a superseding login, or a page leaving).
//!
//! - The callback runs on the login thread; it must not block for long.
//! - Dropping the handle does not cancel; call `cancel`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/login_session.rs
//! ├── cloud::login
//! ├── cloud::machine_api
//! ├── cloud::outcome
//! ├── cloud::paths
//! └── cloud::test_support
//! External: serde_json, std, tempfile
//!
//! Used by:
//! cloud/login_session.rs
//! ├── cloud
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_tests
//! └── yaran-web::cloud_routes
//! <module-headers:end>

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use crate::cloud::login::{LoginIo, LoginOutcome, LoginParams, LoginStep, run_login};

/// What the authorize step shows: the URL to open and the fingerprint to compare.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizeInfo {
    pub url: String,
    pub fingerprint: String,
    pub org_name: String,
    pub machine_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoginEvent {
    Authorize(AuthorizeInfo),
    Step(LoginStep),
    Finished(LoginOutcome),
}

/// Controls one running login.
#[derive(Clone)]
pub struct LoginHandle {
    paste: Sender<String>,
    cancel: Arc<AtomicBool>,
}

impl LoginHandle {
    /// Hand over an address pasted from a browser that could not reach this machine.
    pub fn paste(&self, address: String) {
        let _ = self.paste.send(address);
    }

    /// Stop waiting; the login finishes with `LoginCancelled` within one poll.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

type Sink = Arc<Mutex<Box<dyn FnMut(LoginEvent) + Send>>>;

struct ThreadIo {
    sink: Sink,
    paste: Option<Receiver<String>>,
    cancel: Arc<AtomicBool>,
}

impl ThreadIo {
    fn emit(&self, event: LoginEvent) {
        if let Ok(mut sink) = self.sink.lock() {
            sink(event);
        }
    }
}

impl LoginIo for ThreadIo {
    fn open_browser(&mut self, _url: &str) -> Result<(), String> {
        // The front end opens the URL on `Authorize`.
        Ok(())
    }

    fn show_authorize(&mut self, url: &str, fingerprint: &str, org_name: &str, machine_name: &str) {
        self.emit(LoginEvent::Authorize(AuthorizeInfo {
            url: url.to_string(),
            fingerprint: fingerprint.to_string(),
            org_name: org_name.to_string(),
            machine_name: machine_name.to_string(),
        }));
    }

    fn pasted_callback(&mut self) -> Receiver<String> {
        self.paste.take().unwrap_or_else(|| mpsc::channel().1)
    }

    fn cancelled(&mut self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    fn progress(&mut self, step: LoginStep) {
        self.emit(LoginEvent::Step(step));
    }
}

/// Start a login on a new thread.
pub fn spawn_login(
    params: LoginParams,
    on_event: impl FnMut(LoginEvent) + Send + 'static,
) -> LoginHandle {
    let (paste_tx, paste_rx) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let sink: Sink = Arc::new(Mutex::new(Box::new(on_event)));
    let mut io = ThreadIo {
        sink: Arc::clone(&sink),
        paste: Some(paste_rx),
        cancel: Arc::clone(&cancel),
    };
    std::thread::Builder::new()
        .name("yaran-cloud-login".into())
        .spawn(move || {
            let outcome = run_login(params, &mut io);
            io.emit(LoginEvent::Finished(outcome));
        })
        .expect("spawn the cloud login thread");
    LoginHandle {
        paste: paste_tx,
        cancel,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::machine_api::test_api_factory;
    use crate::cloud::outcome::CloudActionOutcome;
    use crate::cloud::paths::CloudPaths;
    use crate::cloud::test_support::{MockResponse, MockWorker, SAMPLE_ORG};
    use std::time::Duration;

    #[test]
    fn a_spawned_login_reports_authorize_then_finishes_on_cancel() {
        let root = tempfile::tempdir().unwrap();
        let worker = MockWorker::start(|_| {
            MockResponse::json(
                200,
                serde_json::json!({
                    "service": "yaran-cloud", "protocol": {"min": 1, "max": 1}, "setup": "closed",
                    "org": {"name": "Example Org", "url": SAMPLE_ORG},
                    "access": {"team_domain": "team.cloudflareaccess.com"}, "worker": {"version": "1.0.0"},
                    "capabilities": [], "push": {"enabled": false, "vapid_public_key": null}
                }),
            )
        });
        let (tx, rx) = mpsc::channel();
        let handle = spawn_login(
            LoginParams {
                org_url: SAMPLE_ORG.into(),
                machine_name: Some("box".into()),
                origin_port: 3890,
                timeout: Duration::from_secs(30),
                paths: CloudPaths::from_root(root.path()),
                api: test_api_factory(worker.base_url()),
            },
            move |e| {
                let _ = tx.send(e);
            },
        );
        let authorize = loop {
            match rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                LoginEvent::Authorize(a) => break a,
                _ => continue,
            }
        };
        assert!(authorize.url.contains("/v1/pair/authorize?"));
        assert_eq!(authorize.org_name, "Example Org");
        handle.paste("http://127.0.0.1:1/callback".into());
        handle.cancel();
        let finished = loop {
            if let LoginEvent::Finished(o) = rx.recv_timeout(Duration::from_secs(10)).unwrap() {
                break o;
            }
        };
        assert_eq!(finished, CloudActionOutcome::LoginCancelled);
    }
}
