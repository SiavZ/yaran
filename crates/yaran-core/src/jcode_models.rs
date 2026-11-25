//! Bulk model changes through jcode's own CLI, without writing into its composer.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use serde::Serialize;

use crate::bounded_command::{
    ChildGroup, CommandOutcome, DEFAULT_READER_DRAIN, run_command_with_timeout,
};
use crate::engine::Engine;

#[path = "jcode_model_catalog.rs"]
mod catalog;
pub use catalog::{ModelCatalog, ModelChoice, ReasoningLevel, model_catalog};

/// A running jcode tab offered by either surface.
#[derive(Clone, Debug, Serialize)]
pub struct ModelTarget {
    /// Stable Yaran tab id used for selection.
    pub tab_id: String,
    /// The owning agent's display name.
    pub label: String,
    /// Identity of the running client, so a restarted tab is never substituted.
    pub run_id: String,
    #[serde(skip_serializing)]
    process: crate::process_sessions::ProcessSession,
    #[serde(skip_serializing)]
    env: Vec<(String, String)>,
    #[serde(skip_serializing)]
    args: Vec<String>,
    #[serde(skip_serializing)]
    command: String,
    #[serde(skip_serializing)]
    directory: PathBuf,
}

/// Each target gets its own outcome, including partial failures.
#[derive(Clone, Debug, Serialize)]
pub struct ModelChange {
    /// The tab whose change was attempted.
    pub tab_id: String,
    /// The owning agent's display name.
    pub label: String,
    /// Absent when jcode acknowledged the change.
    pub error: Option<String>,
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
                    run_id: format!("{}:{}:{}", process.boot, process.sid, process.started_at),
                    process,
                    directory: pty.spawn_dir().to_path_buf(),
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
    let path = target
        .env
        .iter()
        .rev()
        .find(|(key, _)| key == "JCODE_HOME")
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| std::env::var_os("JCODE_HOME").map(PathBuf::from))
        .or_else(|| home::home_dir().map(|home| home.join(".jcode")))
        .context("Could not locate jcode's client registrations.")?;
    Ok(target.directory.join(path))
}

fn registered_client(target: &ModelTarget, registry: &Path) -> Result<(String, u32)> {
    let processes = crate::process_sessions::snapshot(&[target.process]);
    let boot_now = crate::process_sessions::boot_nanos_now();
    let wall_now = SystemTime::now();
    let read = |process: &crate::process_sessions::ProcessIdentity| -> Option<(String, u32)> {
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
        crate::resume_recovery::jcode_session_id_is_valid(&id).then_some((id, process.pid))
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
    cmd.current_dir(&target.directory);
    cmd.envs(target.env.iter().cloned());
    // Wrappers dispatch on the first argument to bypass interactive registration.
    cmd.args(["debug", "--no-update"]);
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
        cmd.arg("--").arg(arg);
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
            "jcode did not acknowledge the model change within 10 seconds. Check the model, provider and reasoning level in jcode before retrying."
        ),
        CommandOutcome::Failed(error) | CommandOutcome::NotFound(error) => {
            bail!("{}", crate::sanitize::for_terminal(&error))
        }
    }
}

/// Runs off the UI/engine thread, checking each selected client's identity.
///
/// # Errors
///
/// Refuses an invalid native choice or an empty selection before doing work.
/// Individual control failures are returned beside each tab in the outcomes.
pub fn change_models(
    all: &[ModelTarget],
    selected: &BTreeMap<String, String>,
    bindings: &BTreeMap<String, String>,
    choice_id: &str,
    reasoning_effort: Option<&str>,
) -> Result<Vec<ModelChange>> {
    if choice_id.is_empty()
        || choice_id.len() > 8192
        || choice_id.chars().any(char::is_control)
        || reasoning_effort.is_some_and(|level| {
            level.is_empty() || level.len() > 64 || level.chars().any(char::is_control)
        })
    {
        bail!("Choose a native model/provider route and its offered reasoning level.");
    }
    if selected.is_empty() {
        bail!("Select running jcode tabs.");
    }
    let mut outcomes = Vec::new();
    for (id, run_id) in selected {
        let target = all.iter().find(|t| &t.tab_id == id);
        let result = (|| {
            let target = selected_target(all, id, run_id)?;
            let (session, client, choices) = catalog::choices_for_target(target)?;
            if bindings.get(id) != Some(&catalog::binding(&session, &client)) {
                bail!(
                    "This jcode reconnected or changed conversation since its choices were loaded. Reload the native model choices."
                );
            }
            let choice = choices.iter().find(|choice| choice.id == choice_id && choice.available)
                .context("This exact model/provider route is unavailable in this jcode. Reload the choices.")?;
            if reasoning_effort.map_or(!choice.reasoning_levels.is_empty(), |effort| {
                !choice
                    .reasoning_levels
                    .iter()
                    .any(|level| level.value == effort)
            }) {
                bail!(
                    "This reasoning level is not offered for this model/provider route. Reload the choices."
                );
            }
            let request = serde_json::json!({ "selection": choice.selection, "reasoning_effort": reasoning_effort, "client_id": client }).to_string();
            let acknowledgement: serde_json::Value = serde_json::from_str(&debug(
                target,
                Some(&session),
                "set_model_choice",
                Some(&request),
            )?)
            .context("jcode did not acknowledge a model change.")?;
            if acknowledgement.get("id").and_then(|value| value.as_str()) != Some(choice_id)
                || reasoning_effort.is_some()
                    && acknowledgement
                        .get("reasoning_effort")
                        .and_then(|value| value.as_str())
                        != reasoning_effort
                || acknowledgement
                    .get("model")
                    .and_then(|value| value.as_str())
                    .is_none_or(str::is_empty)
            {
                bail!("jcode did not acknowledge a model change.");
            }
            Ok::<_, anyhow::Error>(())
        })();
        outcomes.push(ModelChange {
            tab_id: id.clone(),
            label: target.map_or_else(|| id.clone(), |target| target.label.clone()),
            error: result.err().map(|e| e.to_string()),
        });
    }
    Ok(outcomes)
}

fn selected_target<'a>(all: &'a [ModelTarget], id: &str, run_id: &str) -> Result<&'a ModelTarget> {
    all.iter().find(|target| target.tab_id == id && target.run_id == run_id).context(
        "This tab stopped or restarted. Reopen the model switcher to select its current client.",
    )
}

#[cfg(test)]
#[path = "jcode_models_tests.rs"]
mod tests;
