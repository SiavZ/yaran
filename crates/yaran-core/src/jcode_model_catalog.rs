//! Native jcode picker choices, intersected across the selected running clients.

use super::{ModelTarget, debug, jcode_home, registered_client, selected_target};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A level and label supplied by jcode's own reasoning picker.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReasoningLevel {
    /// Opaque native level used when applying the choice.
    pub value: String,
    /// The label shown in jcode.
    pub label: String,
}

/// One exact model/provider/API route from the native model picker.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelChoice {
    /// Native route identity, never reconstructed from a display name.
    pub id: String,
    /// Native model display name.
    pub name: String,
    /// Native provider/account label.
    pub provider: String,
    /// The selected provider's API/credential method.
    pub api_method: String,
    /// Whether every selected jcode can use this choice.
    pub available: bool,
    /// Native availability information.
    pub detail: String,
    /// The native picker's initially selected reasoning level.
    pub reasoning_effort: Option<String>,
    /// Only levels offered by the selected native clients.
    pub reasoning_levels: Vec<ReasoningLevel>,
    #[serde(skip_serializing)]
    pub(super) selection: serde_json::Value,
}

#[derive(Deserialize)]
struct NativeCatalog {
    choices: Vec<ModelChoice>,
    client_pid: u32,
    client_id: String,
    session_id: String,
}

/// Shared native choices and the client bindings captured while loading them.
#[derive(Clone, Debug, Serialize)]
pub struct ModelCatalog {
    /// Exact native routes shared by the selected clients.
    pub choices: Vec<ModelChoice>,
    /// Opaque comparison values; these are never used to address a client.
    pub bindings: BTreeMap<String, String>,
}

pub(super) fn binding(session: &str, client: &str) -> String {
    serde_json::json!([session, client]).to_string()
}

pub(super) fn choices_for_target(
    target: &ModelTarget,
) -> Result<(String, String, Vec<ModelChoice>)> {
    let (session, pid) = registered_client(target, &jcode_home(target)?.join("client_sessions"))?;
    let output = debug(target, Some(&session), "client:model-options", None)?;
    let catalog: NativeCatalog = serde_json::from_str(&output).context(
        "This jcode cannot export its native model choices. Update jcode and reload its server and clients, then retry.",
    )?;
    if catalog.client_pid != pid || catalog.session_id != session || catalog.client_id.is_empty() {
        bail!(
            "This jcode client reconnected or changed conversation. Reload the native model choices."
        );
    }
    if catalog.choices.is_empty() {
        bail!("The native model catalog is not ready. Open /models in this jcode and retry.");
    }
    Ok((session, catalog.client_id, catalog.choices))
}

/// Load the same choices as `/models`, keeping only shared model/provider routes.
///
/// # Errors
/// Refuses stale clients or an unavailable native catalog without inventing choices.
pub fn model_catalog(
    all: &[ModelTarget],
    selected: &BTreeMap<String, String>,
) -> Result<ModelCatalog> {
    if selected.is_empty() {
        bail!("Select running jcode tabs first.");
    }
    let mut common: Option<Vec<ModelChoice>> = None;
    let mut bindings = BTreeMap::new();
    for (id, run) in selected {
        let target = selected_target(all, id, run)?;
        let (session, client, choices) = choices_for_target(target).map_err(|error| {
            anyhow::anyhow!(
                "Could not load model choices for {} ({id}): {error:#}",
                target.label
            )
        })?;
        bindings.insert(id.clone(), binding(&session, &client));
        if let Some(common) = &mut common {
            common.retain_mut(|choice| {
                let Some(other) = choices.iter().find(|other| other.id == choice.id) else {
                    return false;
                };
                if !other.available {
                    choice.detail.clone_from(&other.detail);
                }
                choice.available &= other.available;
                let needs_level =
                    !choice.reasoning_levels.is_empty() || !other.reasoning_levels.is_empty();
                choice.reasoning_levels.retain(|level| {
                    other
                        .reasoning_levels
                        .iter()
                        .any(|other| other.value == level.value)
                });
                if needs_level && choice.reasoning_levels.is_empty() {
                    choice.available = false;
                    choice.detail =
                        "These jcodes do not share a reasoning level for this route.".into();
                }
                if !choice
                    .reasoning_levels
                    .iter()
                    .any(|level| Some(&level.value) == choice.reasoning_effort.as_ref())
                {
                    choice.reasoning_effort = choice
                        .reasoning_levels
                        .first()
                        .map(|level| level.value.clone());
                }
                true
            });
        } else {
            common = Some(choices);
        }
    }
    Ok(ModelCatalog {
        choices: common.unwrap_or_default(),
        bindings,
    })
}
