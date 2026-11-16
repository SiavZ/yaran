//! `yaran cloud login`: the terminal front end of `cloud::login::run_login`.
//!
//! Prints the org, the machine name, the authorize URL and the key fingerprint, opens
//! the browser (a failure just leaves the URL on screen, 19 hook H1), and reads pasted
//! callback addresses from stdin on a helper thread for SSH sessions. After pairing it
//! says whether a running yaran picked the credentials up (its leg-state file appears).
//!
//! - Blocking; the CLI's own thread.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cli/login.rs
//! ├── cloud::cli
//! ├── cloud::leg_state
//! ├── cloud::login
//! └── cloud::outcome
//! External: std
//!
//! Used by:
//! cloud/cli/login.rs
//! └── cloud::cli
//! <module-headers:end>

use std::io::{BufRead, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use super::{CloudDeps, finish};
use crate::cloud::leg_state;
use crate::cloud::login::{LoginIo, LoginParams, LoginStep, run_login};
use crate::cloud::outcome::CloudActionOutcome;

struct CliIo<'a> {
    out: &'a mut dyn Write,
    open: &'a mut dyn FnMut(&str) -> Result<(), String>,
    no_browser: bool,
    stdin: Option<Box<dyn BufRead + Send>>,
}

impl LoginIo for CliIo<'_> {
    fn open_browser(&mut self, url: &str) -> Result<(), String> {
        if self.no_browser {
            return Ok(());
        }
        (self.open)(url)
    }

    fn show_authorize(&mut self, url: &str, fingerprint: &str, org_name: &str, machine_name: &str) {
        let _ = writeln!(
            self.out,
            "Pairing this machine with {org_name} as \"{machine_name}\".\n\n\
             Open this address to approve it:\n  {url}\n\n\
             Machine key fingerprint: {fingerprint}\n\
             Check that your browser shows the same code before you approve.\n"
        );
    }

    fn pasted_callback(&mut self) -> Receiver<String> {
        let (tx, rx) = mpsc::channel();
        if let Some(mut stdin) = self.stdin.take() {
            // Detached on purpose: a blocked stdin read cannot be cancelled, and the
            // process exits when login ends.
            std::thread::spawn(move || {
                let mut line = String::new();
                while stdin.read_line(&mut line).is_ok_and(|n| n > 0) {
                    if !line.trim().is_empty() && tx.send(line.trim().to_string()).is_err() {
                        break;
                    }
                    line.clear();
                }
            });
        }
        rx
    }

    fn cancelled(&mut self) -> bool {
        false
    }

    fn progress(&mut self, step: LoginStep) {
        let line = match step {
            LoginStep::CheckingOrg { org_url } => format!("Checking {org_url}…"),
            LoginStep::BrowserUnavailable { url } => CloudActionOutcome::BrowserUnavailable { url }
                .report()
                .message()
                .to_string(),
            LoginStep::Waiting => {
                "Waiting… (paste the address your browser lands on if it can't reach this machine)"
                    .into()
            }
            LoginStep::PasteRejected { reason } => reason,
            LoginStep::Claiming => "Approved; finishing the pairing…".into(),
        };
        let _ = writeln!(self.out, "{line}");
    }
}

pub(super) fn run(
    mut deps: CloudDeps,
    url: Option<String>,
    name: Option<String>,
    no_browser: bool,
    stdin: Box<dyn BufRead + Send>,
    out: &mut dyn Write,
) -> i32 {
    let org_url = url.unwrap_or_else(|| deps.config.org_url.clone());
    if org_url.trim().is_empty() {
        let _ = writeln!(
            out,
            "Which organization? Run `yaran cloud login https://<your-org-control-plane>`, or set [cloud] org_url."
        );
        return 2;
    }
    let params = LoginParams {
        org_url,
        machine_name: name,
        origin_port: deps.server_port,
        timeout: Duration::from_secs(deps.config.login_timeout_seconds.max(1)),
        paths: deps.paths.clone(),
        api: deps.api.clone(),
    };
    let outcome = {
        let mut io = CliIo {
            out: &mut *out,
            open: &mut *deps.open_browser,
            no_browser,
            stdin: Some(stdin),
        };
        run_login(params, &mut io)
    };
    let code = finish(&outcome, out);
    if matches!(outcome, CloudActionOutcome::Paired { .. }) {
        let deadline = Instant::now() + deps.pickup_wait;
        let picked_up = loop {
            if !matches!(
                leg_state::status(&deps.paths),
                leg_state::LegStatus::NotRunning
            ) {
                break true;
            }
            if Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(Duration::from_millis(250));
        };
        let _ = writeln!(
            out,
            "{}",
            if picked_up {
                "A running yaran picked up the new pairing and is starting remote access."
            } else {
                "No yaran is serving remote access right now; start `yaran server`, or turn on [server] serve_while_tui, and it connects by itself."
            }
        );
    }
    code
}
