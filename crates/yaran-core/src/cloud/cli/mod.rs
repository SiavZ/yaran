//! `yaran cloud`: pair this machine with a Yaran Cloud organization, and manage it.
//!
//! Dispatched by the binary before the TUI's argument handling (which treats `--help`
//! anywhere as top-level help). Takes no single-instance lock, runs no engine, and
//! never writes `config.toml` (a running yaran would clobber the edit); the paired
//! org lives in the credentials. `run_with` is the testable body: every dependency,
//! including the control-plane client factory and stdin, comes in through arguments.
//!
//! - Exit codes: 0 success, 1 failure, 2 usage; `status` adds 3 (paired, leg not
//!   running), 4 (not paired) and 5 (revoked).
//!
//! <module-headers:begin>
//! <module-headers:end>

mod args;
mod login;
mod manage;
mod pair_phone;

use std::io::{BufRead, Write};
use std::time::Duration;

pub use args::{CloudCommand, Verb, parse};

use crate::cloud::config::CloudConfig;
use crate::cloud::machine_api::{ApiFactory, default_api_factory};
use crate::cloud::outcome::CloudActionOutcome;
use crate::cloud::paths::CloudPaths;

pub const CLOUD_HELP: &str = "\
Usage: yaran cloud <command> [OPTIONS]

Connect this machine to your organization's Yaran Cloud, so your phone can reach it.

Commands:
  login [<url>]   Pair this machine (opens your browser; works over SSH too)
  logout          Unpair this machine and delete its credentials
  status          Show whether this machine is paired and its tunnel is up
  rotate          Rotate the tunnel token (or, with --consent-key, the phone consent key)
  pair-phone      Show a QR code that adds your organization to the Yaran app

Run `yaran cloud <command> --help` for a command's options.";

const LOGIN_HELP: &str = "\
Usage: yaran cloud login [<url>] [--name <name>] [--no-browser]

Pair this machine with the Yaran Cloud at <url> (default: [cloud] org_url).
yaran prints the address it opens and this machine's key fingerprint: check that
the browser's confirm page shows the same code. If the browser is on another
device (an SSH session), open the address there and paste the address it lands
on back here.

Options:
      --name <name>  Machine name: 1-32 lowercase letters, digits and hyphens
                     (default: this computer's short hostname)
      --no-browser   Only print the address; do not open a browser
  -h, --help         Print this help";

const LOGOUT_HELP: &str = "\
Usage: yaran cloud logout [--yes] [--local-only]

Tell the control plane to remove this machine, then delete its credentials.
Asks first on a terminal; elsewhere --yes is required.

Options:
  -y, --yes          Do not ask for confirmation
      --local-only   Forget the credentials without telling the control plane.
                     The tunnel token stays valid until an administrator removes
                     the machine, so ask them to.
  -h, --help         Print this help";

const STATUS_HELP: &str = "\
Usage: yaran cloud status [--json] [--offline]

Show the pairing (never a secret), the [cloud] mode, and the tunnel leg of a
running yaran, then ask the control plane for this machine's config.

Options:
      --json      Print one JSON object
      --offline   Do not contact the control plane
  -h, --help      Print this help

Exit codes: 0 paired and the tunnel is ready; 3 paired and the tunnel is not
running; 4 not paired; 5 revoked; 1 an error.";

const ROTATE_HELP: &str = "\
Usage: yaran cloud rotate [--yes] [--consent-key]

Rotate this machine's tunnel token; a running yaran reconnects with the new one.
Asks first on a terminal; elsewhere --yes is required.

Options:
  -y, --yes          Do not ask for confirmation
      --consent-key  Instead, replace the key that remembers which phones already
                     confirmed signing in here. No network call; every phone sees
                     the consent page once more on this machine.
  -h, --help         Print this help";

const PAIR_PHONE_HELP: &str = "\
Usage: yaran cloud pair-phone [--org <url>]

Print a QR code that adds your organization to the Yaran app. The organization
is the paired one, else --org, else [cloud] org_url.

Options:
      --org <url>  The organization to add when this machine is not paired
  -h, --help       Print this help";

fn help_for(verb: Option<Verb>) -> &'static str {
    match verb {
        None => CLOUD_HELP,
        Some(Verb::Login) => LOGIN_HELP,
        Some(Verb::Logout) => LOGOUT_HELP,
        Some(Verb::Status) => STATUS_HELP,
        Some(Verb::Rotate) => ROTATE_HELP,
        Some(Verb::PairPhone) => PAIR_PHONE_HELP,
    }
}

/// Opens a URL in a browser, or says why it could not.
pub type BrowserOpener = Box<dyn FnMut(&str) -> Result<(), String>>;

/// Everything `run_with` needs from the outside world.
pub struct CloudDeps {
    pub paths: CloudPaths,
    pub config: CloudConfig,
    /// The effective `[server] port`, sent as `origin_port` at login.
    pub server_port: u16,
    pub api: ApiFactory,
    /// Whether stdin is a terminal (confirms are asked only there).
    pub is_tty: bool,
    pub open_browser: BrowserOpener,
    /// How long login waits after pairing for a running yaran to pick it up.
    pub pickup_wait: Duration,
}

/// `yaran cloud ...` from the binary. Returns the process exit code.
pub fn run_cloud(args: &[String], paths: &crate::config::YaranPaths) -> i32 {
    use std::io::IsTerminal;
    let config = crate::config::load_config(paths);
    let deps = CloudDeps {
        paths: CloudPaths::new(paths),
        api: default_api_factory(Duration::from_secs(
            config.cloud.request_timeout_seconds.max(1),
        )),
        server_port: config.server.port,
        config: config.cloud,
        is_tty: std::io::stdin().is_terminal(),
        open_browser: Box::new(|url| crate::browser::open_url(url).map_err(|e| e.to_string())),
        pickup_wait: Duration::from_secs(6),
    };
    let stdin: Box<dyn BufRead + Send> = Box::new(std::io::BufReader::new(std::io::stdin()));
    run_with(args, deps, stdin, &mut std::io::stdout())
}

/// The testable body of [`run_cloud`].
pub fn run_with(
    args: &[String],
    deps: CloudDeps,
    stdin: Box<dyn BufRead + Send>,
    out: &mut dyn Write,
) -> i32 {
    let command = match parse(args) {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(out, "{e}");
            return 2;
        }
    };
    match command {
        CloudCommand::Help(verb) => {
            let _ = writeln!(out, "{}", help_for(verb));
            0
        }
        CloudCommand::Login {
            url,
            name,
            no_browser,
        } => login::run(deps, url, name, no_browser, stdin, out),
        CloudCommand::Logout { yes, local_only } => {
            manage::logout(&deps, yes, local_only, stdin, out)
        }
        CloudCommand::Status { json, offline } => manage::status(&deps, json, offline, out),
        CloudCommand::Rotate { yes, consent_key } => {
            manage::rotate(&deps, yes, consent_key, stdin, out)
        }
        CloudCommand::PairPhone { org } => pair_phone::run(&deps, org, out),
    }
}

/// Print an outcome's sentence and return its exit code.
fn finish(outcome: &CloudActionOutcome, out: &mut dyn Write) -> i32 {
    let _ = writeln!(out, "{}", outcome.report().message());
    if outcome.is_failure() { 1 } else { 0 }
}

/// Ask a yes/no question on a terminal; off a terminal `--yes` is required.
/// `Err(code)` means stop with that exit code.
fn confirm(
    deps: &CloudDeps,
    yes: bool,
    question: &str,
    stdin: &mut dyn BufRead,
    out: &mut dyn Write,
) -> Result<(), i32> {
    if yes {
        return Ok(());
    }
    if !deps.is_tty {
        let _ = writeln!(
            out,
            "{question} This is not a terminal, so pass --yes to confirm."
        );
        return Err(2);
    }
    let _ = write!(out, "{question} [y/N] ");
    let _ = out.flush();
    let mut line = String::new();
    let _ = stdin.read_line(&mut line);
    if matches!(line.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        Ok(())
    } else {
        let _ = writeln!(out, "Nothing was changed.");
        Err(1)
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
