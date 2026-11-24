//! Bulk model changes through jcode's own CLI, without writing into its composer.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::bounded_command::{
    ChildGroup, CommandOutcome, DEFAULT_READER_DRAIN, run_command_with_timeout,
};
use crate::engine::Engine;

/// A running jcode tab offered by either surface.
#[derive(Clone, Debug, Serialize)]
pub struct ModelTarget {
    /// Stable Yaran tab id used for selection.
    pub tab_id: String,
    /// The owning agent's display name.
    pub label: String,
    #[serde(skip_serializing)]
    process: crate::process_sessions::ProcessSession,
    #[serde(skip_serializing)]
    env: Vec<(String, String)>,
    #[serde(skip_serializing)]
    args: Vec<String>,
    #[serde(skip_serializing)]
    command: String,
}

/// Each target gets its own outcome, including partial failures.
#[derive(Debug, Serialize)]
pub struct ModelChange {
    /// The tab whose change was attempted.
    pub tab_id: String,
    /// The owning agent's display name.
    pub label: String,
    /// Absent when jcode acknowledged the change.
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct NativeSession {
    session_id: String,
}

impl Engine {
    /// Only live jcode tabs, including extra tabs and standalone agents.
    pub fn jcode_model_targets(&self) -> Vec<ModelTarget> {
        let mut targets = Vec::new();
        for session in &self.sessions {
            for (tab_id, pty) in &self.providers {
                let belongs = session.slot_tab_id() == &**tab_id
                    || self
                        .agent_tabs
                        .get(tab_id)
                        .is_some_and(|tab| tab.session_id == session.id);
                if !belongs {
                    continue;
                }
                let Some(process) = pty.process_session() else {
                    continue;
                };
                let provider = self.tab_running_provider(session, tab_id);
                if provider.as_str() != "jcode" {
                    continue;
                }
                let Some(config) = self.config.providers.commands.get(provider.as_str()) else {
                    continue;
                };
                targets.push(ModelTarget {
                    tab_id: tab_id.as_str().to_string(),
                    label: session.display_label(),
                    process,
                    env: self.session_env(session),
                    args: config.args.clone(),
                    command: config.command.clone(),
                });
            }
        }
        targets.sort_by(|a, b| a.label.cmp(&b.label).then(a.tab_id.cmp(&b.tab_id)));
        targets
    }
}

fn jcode_home(target: &ModelTarget) -> Result<PathBuf> {
    target
        .env
        .iter()
        .rev()
        .find(|(key, _)| key == "JCODE_HOME")
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| std::env::var_os("JCODE_HOME").map(PathBuf::from))
        .or_else(|| home::home_dir().map(|home| home.join(".jcode")))
        .context("Could not locate jcode's client registrations.")
}

fn registered_session(target: &ModelTarget, registry: &Path) -> Result<String> {
    let processes = crate::process_sessions::snapshot(&[target.process]);
    let boot_now = crate::process_sessions::boot_nanos_now();
    let wall_now = SystemTime::now();
    let read = |process: &crate::process_sessions::ProcessIdentity| -> Option<String> {
        let path = registry.join(process.pid.to_string());
        // Kernel start time also survives Yaran adopting this PTY during reload.
        if process.start_time == 0 {
            return None;
        }
        let started = wall_now.checked_sub(Duration::from_nanos(
            boot_now.saturating_sub(process.start_time),
        ))?;
        if std::fs::metadata(&path).ok()?.modified().ok()? < started {
            return None;
        }
        let id = std::fs::read_to_string(path).ok()?.trim().to_string();
        crate::resume_recovery::jcode_session_id_is_valid(&id).then_some(id)
    };
    if let Some(process) = processes
        .iter()
        .find(|process| process.pid == target.process.sid)
        && let Some(id) = read(process)
    {
        return Ok(id);
    }
    let ids: HashSet<_> = processes.iter().filter_map(read).collect();
    if ids.len() != 1 {
        bail!(
            "Could not identify this tab's jcode conversation. Focus it once and retry; update jcode if it does not record client sessions."
        );
    }
    Ok(ids.into_iter().next().expect("exactly one registration"))
}

fn debug(
    target: &ModelTarget,
    session: Option<&str>,
    verb: &str,
    arg: Option<&str>,
) -> Result<String> {
    if target
        .args
        .iter()
        .any(|arg| arg == "--ssh" || arg.starts_with("--ssh="))
    {
        bail!(
            "Bulk model switching requires a local jcode client. Change this SSH client's model inside jcode."
        );
    }
    let mut cmd = Command::new(&target.command);
    cmd.envs(target.env.iter().cloned());
    cmd.args(["--no-update", "debug"]);
    for (index, arg) in target.args.iter().enumerate() {
        if arg == "--socket" {
            let socket = target
                .args
                .get(index + 1)
                .context("jcode's --socket argument has no path.")?;
            cmd.args(["--socket", socket]);
        } else if let Some(socket) = arg.strip_prefix("--socket=") {
            cmd.args(["--socket", socket]);
        }
    }
    if let Some(session) = session {
        cmd.args(["--session", session]);
    }
    cmd.arg(verb);
    if let Some(arg) = arg {
        cmd.arg(arg);
    }
    match run_command_with_timeout(
        cmd,
        ChildGroup::New,
        Duration::from_secs(10),
        DEFAULT_READER_DRAIN,
        "jcode model control",
    ) {
        CommandOutcome::Completed(out) if out.status.success() => {
            Ok(String::from_utf8(out.stdout)?)
        }
        CommandOutcome::Completed(out) => {
            let detail = crate::sanitize::for_terminal(&String::from_utf8_lossy(&out.stderr));
            bail!(
                "jcode model control failed. Enable display.debug_socket in jcode's config and reload its server if control is disabled. {detail}"
            );
        }
        CommandOutcome::TimedOut => bail!(
            "jcode did not acknowledge the model change within 10 seconds. Check the model in jcode before retrying."
        ),
        CommandOutcome::Failed(error) | CommandOutcome::NotFound(error) => {
            bail!("{}", crate::sanitize::for_terminal(&error))
        }
    }
}

/// Runs off the UI/engine thread. An empty or stale selection changes nothing.
///
/// # Errors
///
/// Refuses an invalid model id or an empty/stale tab selection before doing work.
/// Individual control failures are returned beside each tab in the outcomes.
pub fn change_models(
    all: &[ModelTarget],
    selected: &[String],
    model: &str,
) -> Result<Vec<ModelChange>> {
    let model = model.trim();
    if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
        bail!("Enter a model id of at most 256 bytes, without control characters.");
    }
    let ids: HashSet<_> = selected.iter().collect();
    if ids.is_empty() || ids.iter().any(|id| !all.iter().any(|t| &t.tab_id == *id)) {
        bail!(
            "Select running jcode tabs. A selected tab may have stopped; reopen the model switcher and try again."
        );
    }
    let mut outcomes = Vec::new();
    for target in all.iter().filter(|t| ids.contains(&t.tab_id)) {
        let result = (|| {
            let registry = jcode_home(target)?.join("client_sessions");
            let session = registered_session(target, &registry)?;
            let native: Vec<NativeSession> =
                serde_json::from_str(&debug(target, None, "sessions", None)?)
                    .context("Could not read jcode's connected conversations.")?;
            if !native.iter().any(|native| native.session_id == session) {
                bail!(
                    "This tab's jcode conversation is no longer connected. Focus it and try again."
                );
            }
            debug(target, Some(&session), "set_model", Some(model))?;
            Ok::<_, anyhow::Error>(())
        })();
        outcomes.push(ModelChange {
            tab_id: target.tab_id.clone(),
            label: target.label.clone(),
            error: result.err().map(|e| e.to_string()),
        });
    }
    Ok(outcomes)
}

#[cfg(test)]
#[path = "jcode_models_tests.rs"]
mod tests;
