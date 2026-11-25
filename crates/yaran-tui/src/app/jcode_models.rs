//! Native model/provider/reasoning choices for selected running jcode clients.

use super::components::{FocusStep, ScrollViewRender};
use super::modal::{ModalKeyStep, TextFieldFocus, modal_key_step};
use super::text_input::TextInput;
use super::ui_jobs::UiJob;
use super::{App, PromptState};
use crate::keybindings::{Action, BindingScope};
use ratatui::crossterm::event::KeyEvent;
use std::collections::{BTreeMap, HashSet};
use yaran_core::jcode_models::{ModelChange, ModelChoice, ModelTarget, change_models};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModelsFocus {
    Model,
    Reasoning,
    All,
    Target(usize),
    Apply,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModelsPickerKind {
    Model,
    Reasoning,
}

#[derive(Clone, Debug)]
pub(super) struct ModelsPicker {
    pub(super) kind: ModelsPickerKind,
    pub(super) filter: TextInput,
    pub(super) selected: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct ModelsPrompt {
    pub(super) targets: Vec<ModelTarget>,
    pub(super) selected: HashSet<String>,
    pub(super) choices: Vec<ModelChoice>,
    pub(super) bindings: BTreeMap<String, String>,
    pub(super) choice: Option<usize>,
    pub(super) reasoning: Option<String>,
    pub(super) picking: Option<ModelsPicker>,
    pub(super) focus: ModelsFocus,
    pub(super) busy: bool,
    pub(super) loading: bool,
    pub(super) error: Option<String>,
    pub(super) outcomes: Option<Vec<ModelChange>>,
    pub(super) scroll: ScrollViewRender,
}

impl ModelsPrompt {
    pub(super) fn new(targets: Vec<ModelTarget>) -> Self {
        Self {
            targets,
            selected: HashSet::new(),
            choices: Vec::new(),
            bindings: BTreeMap::new(),
            choice: None,
            reasoning: None,
            picking: None,
            focus: ModelsFocus::All,
            busy: false,
            loading: false,
            error: None,
            outcomes: None,
            scroll: ScrollViewRender::default(),
        }
    }

    pub(super) fn selected_runs(&self) -> BTreeMap<String, String> {
        self.targets
            .iter()
            .filter(|target| self.selected.contains(&target.tab_id))
            .map(|target| (target.tab_id.clone(), target.run_id.clone()))
            .collect()
    }

    pub(super) fn chosen(&self) -> Option<&ModelChoice> {
        self.choice.and_then(|index| self.choices.get(index))
    }

    pub(super) fn can_apply(&self) -> bool {
        !self.selected.is_empty()
            && self.chosen().is_some_and(|choice| {
                choice.available
                    && self.reasoning.as_deref().map_or(
                        choice.reasoning_levels.is_empty(),
                        |effort| {
                            choice
                                .reasoning_levels
                                .iter()
                                .any(|level| level.value == effort)
                        },
                    )
            })
    }

    fn move_focus(&mut self, step: FocusStep) {
        let mut ring = vec![
            (ModelsFocus::Model, !self.selected.is_empty()),
            (
                ModelsFocus::Reasoning,
                self.chosen()
                    .is_some_and(|choice| !choice.reasoning_levels.is_empty()),
            ),
            (ModelsFocus::All, !self.targets.is_empty()),
        ];
        ring.extend(
            self.targets
                .iter()
                .enumerate()
                .map(|(i, _)| (ModelsFocus::Target(i), true)),
        );
        ring.extend([
            (ModelsFocus::Cancel, true),
            (ModelsFocus::Apply, self.can_apply()),
        ]);
        self.focus = super::components::next_focus(&ring, self.focus, step);
    }

    fn toggle(&mut self) {
        match self.focus {
            ModelsFocus::All if self.selected.len() == self.targets.len() => self.selected.clear(),
            ModelsFocus::All => {
                self.selected = self
                    .targets
                    .iter()
                    .map(|target| target.tab_id.clone())
                    .collect();
            }
            ModelsFocus::Target(i) => {
                let id = self.targets[i].tab_id.clone();
                if !self.selected.remove(&id) {
                    self.selected.insert(id);
                }
            }
            _ => return,
        }
        self.choices.clear();
        self.bindings.clear();
        self.choice = None;
        self.reasoning = None;
        self.error = None;
    }
}

impl App {
    pub(super) fn open_jcode_models(&mut self) {
        self.prompt =
            PromptState::JcodeModels(ModelsPrompt::new(self.engine.jcode_model_targets()));
    }

    fn apply_jcode_models(&mut self) {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return;
        };
        let Some(choice) = prompt.chosen().filter(|_| prompt.can_apply()) else {
            prompt.error = Some(
                "Choose running jcodes, a native model/provider, and its reasoning level.".into(),
            );
            return;
        };
        if prompt.selected.is_empty() {
            return;
        }
        let choice_id = choice.id.clone();
        let reasoning = prompt.reasoning.clone();
        let targets = self.engine.jcode_model_targets();
        let selected = prompt.selected_runs();
        let bindings = prompt.bindings.clone();
        prompt.busy = true;
        prompt.error = None;
        self.spawn_ui_job(
            UiJob {
                busy: "Changing the selected jcode models...".into(),
                stopped: "The model worker stopped. Check models in jcode before retrying.".into(),
            },
            move || {
                change_models(
                    &targets,
                    &selected,
                    &bindings,
                    &choice_id,
                    reasoning.as_deref(),
                )
            },
            App::finish_jcode_models,
        );
    }

    pub(super) fn finish_jcode_models(&mut self, answer: Option<anyhow::Result<Vec<ModelChange>>>) {
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            prompt.busy = false;
        }
        match answer {
            Some(Ok(outcomes)) => {
                let changed = outcomes
                    .iter()
                    .filter(|outcome| outcome.error.is_none())
                    .count();
                let summary = format!(
                    "{changed} native choices applied; {} failed or partial.",
                    outcomes.len() - changed
                );
                if changed == outcomes.len() {
                    self.set_info(summary);
                } else {
                    self.set_error(summary);
                }
                if let PromptState::JcodeModels(prompt) = &mut self.prompt {
                    prompt.outcomes = Some(outcomes);
                    prompt.focus = ModelsFocus::Cancel;
                }
            }
            Some(Err(error)) => {
                if let PromptState::JcodeModels(prompt) = &mut self.prompt {
                    prompt.error = Some(error.to_string());
                }
            }
            None => {
                if let PromptState::JcodeModels(prompt) = &mut self.prompt {
                    prompt.error = Some(
                        "The model worker stopped. Check models in jcode before retrying.".into(),
                    );
                }
            }
        }
    }

    fn activate_jcode_models_focus(&mut self) {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return;
        };
        if prompt.busy {
            return;
        }
        if prompt.loading || prompt.outcomes.is_some() {
            if prompt.focus == ModelsFocus::Cancel {
                self.prompt = PromptState::None;
            }
            return;
        }
        if prompt.picking.is_some() {
            if prompt.focus == ModelsFocus::Cancel {
                prompt.picking = None;
            } else {
                self.choose_jcode_model_option();
            }
            return;
        }
        match prompt.focus {
            ModelsFocus::Model => self.load_jcode_model_choices(),
            ModelsFocus::Reasoning => {
                if prompt
                    .chosen()
                    .is_some_and(|choice| !choice.reasoning_levels.is_empty())
                {
                    let selected = prompt
                        .chosen()
                        .and_then(|choice| {
                            choice
                                .reasoning_levels
                                .iter()
                                .position(|level| Some(&level.value) == prompt.reasoning.as_ref())
                        })
                        .unwrap_or(0);
                    prompt.picking = Some(ModelsPicker {
                        kind: ModelsPickerKind::Reasoning,
                        filter: TextInput::new(),
                        selected,
                    });
                }
            }
            ModelsFocus::Apply => self.apply_jcode_models(),
            ModelsFocus::Cancel => self.prompt = PromptState::None,
            _ => prompt.toggle(),
        }
    }

    pub(super) fn handle_jcode_models_key(&mut self, key: KeyEvent) -> bool {
        self.pressed_button = None;
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return false;
        };
        if prompt.busy {
            return false;
        }
        if prompt.loading {
            if self.bindings.lookup(&key, BindingScope::Dialog) == Some(Action::CloseOverlay) {
                self.prompt = PromptState::None;
            }
            return false;
        }
        if prompt.outcomes.is_some() {
            return self.handle_jcode_models_results_key(key);
        }
        if prompt.picking.is_some() {
            return self.handle_jcode_model_picker_key(key);
        }
        let action = self
            .bindings
            .lookup(&key, BindingScope::Dialog)
            .or_else(|| self.bindings.lookup(&key, BindingScope::Palette));
        match modal_key_step(action, key, TextFieldFocus::Elsewhere) {
            ModalKeyStep::Close => self.prompt = PromptState::None,
            ModalKeyStep::MoveFocus(step) => prompt.move_focus(step),
            ModalKeyStep::Confirm | ModalKeyStep::ActivateFocus => {
                self.activate_jcode_models_focus();
            }
            ModalKeyStep::FallThroughToField => match action {
                Some(Action::MoveDown) => prompt.move_focus(FocusStep::Forward),
                Some(Action::MoveUp) => prompt.move_focus(FocusStep::Backward),
                _ => {}
            },
        }
        false
    }

    pub(super) fn press_jcode_models_focus(&mut self, focus: ModelsFocus) {
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            if let Some(picker) = &mut prompt.picking
                && let ModelsFocus::Target(index) = focus
            {
                picker.selected = index;
            } else {
                prompt.focus = focus;
            }
        }
        self.activate_jcode_models_focus();
    }
}

#[cfg(test)]
#[path = "jcode_models_tests.rs"]
mod tests;
