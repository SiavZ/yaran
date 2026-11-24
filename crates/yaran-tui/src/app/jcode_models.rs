//! One model id, applied to selected running jcodes through their own CLI.

use std::collections::HashSet;

use ratatui::crossterm::event::KeyEvent;
use yaran_core::jcode_models::{ModelChange, ModelTarget, change_models};

use super::components::{FocusStep, ScrollViewRender};
use super::modal::{ModalKeyStep, TextFieldFocus, binding_lookup_is_suppressed, modal_key_step};
use super::text_input::TextInput;
use super::ui_jobs::UiJob;
use super::{App, PromptState};
use crate::keybindings::{Action, BindingScope};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ModelsFocus {
    Model,
    All,
    Target(usize),
    Apply,
    Cancel,
}

#[derive(Clone, Debug)]
pub(crate) struct ModelsPrompt {
    pub(super) targets: Vec<ModelTarget>,
    pub(super) selected: HashSet<String>,
    pub(super) model: TextInput,
    pub(super) focus: ModelsFocus,
    pub(super) busy: bool,
    pub(super) error: Option<String>,
    pub(super) outcomes: Option<Vec<ModelChange>>,
    pub(super) scroll: ScrollViewRender,
}

impl ModelsPrompt {
    fn move_focus(&mut self, step: FocusStep) {
        let count = self.targets.len() + 4;
        let index = match self.focus {
            ModelsFocus::Model => 0,
            ModelsFocus::All => 1,
            ModelsFocus::Target(i) => i + 2,
            ModelsFocus::Apply => count - 2,
            ModelsFocus::Cancel => count - 1,
        };
        let next = match step {
            FocusStep::Forward => (index + 1) % count,
            FocusStep::Backward => (index + count - 1) % count,
        };
        self.focus = match next {
            0 => ModelsFocus::Model,
            1 => ModelsFocus::All,
            i if i == count - 2 => ModelsFocus::Apply,
            i if i == count - 1 => ModelsFocus::Cancel,
            i => ModelsFocus::Target(i - 2),
        };
    }

    fn toggle(&mut self) {
        match self.focus {
            ModelsFocus::All if self.selected.len() == self.targets.len() => self.selected.clear(),
            ModelsFocus::All => {
                self.selected = self.targets.iter().map(|t| t.tab_id.clone()).collect();
            }
            ModelsFocus::Target(i) => {
                let id = self.targets[i].tab_id.clone();
                if !self.selected.remove(&id) {
                    self.selected.insert(id);
                }
            }
            _ => {}
        }
    }
}

impl App {
    pub(super) fn open_jcode_models(&mut self) {
        self.prompt = PromptState::JcodeModels(ModelsPrompt {
            targets: self.engine.jcode_model_targets(),
            selected: HashSet::new(),
            model: TextInput::new(),
            focus: ModelsFocus::Model,
            busy: false,
            error: None,
            outcomes: None,
            scroll: ScrollViewRender::default(),
        });
    }

    fn apply_jcode_models(&mut self) {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return;
        };
        if prompt.selected.is_empty() || prompt.model.text.trim().is_empty() {
            prompt.error = Some(
                "Choose running jcodes and enter a model ID before applying the change.".into(),
            );
            return;
        }
        let targets = self.engine.jcode_model_targets();
        let selected = prompt
            .targets
            .iter()
            .filter(|target| prompt.selected.contains(&target.tab_id))
            .map(|target| (target.tab_id.clone(), target.run_id.clone()))
            .collect();
        let model = prompt.model.text.clone();
        prompt.busy = true;
        prompt.error = None;
        self.spawn_ui_job(
            UiJob {
                busy: "Changing the selected jcode models...".into(),
                stopped: "The model worker stopped. Check models in jcode before retrying.".into(),
            },
            move || change_models(&targets, &selected, &model),
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
                    "Changed {changed} jcode models; {} failed.",
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
                let message = error.to_string();
                if let PromptState::JcodeModels(prompt) = &mut self.prompt {
                    prompt.error = Some(message.clone());
                }
                self.set_error(message);
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
        if prompt.outcomes.is_some() {
            if prompt.focus == ModelsFocus::Cancel {
                self.prompt = PromptState::None;
            }
            return;
        }
        match prompt.focus {
            ModelsFocus::Model | ModelsFocus::Apply => self.apply_jcode_models(),
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
        if prompt.outcomes.is_some() {
            return self.handle_jcode_models_results_key(key);
        }
        let field = if prompt.focus == ModelsFocus::Model {
            TextFieldFocus::Field
        } else {
            TextFieldFocus::Elsewhere
        };
        let action = if binding_lookup_is_suppressed(key, field, self.extended_keys) {
            None
        } else {
            self.bindings
                .lookup(&key, BindingScope::Dialog)
                .or_else(|| self.bindings.lookup(&key, BindingScope::Palette))
        };
        match modal_key_step(action, key, field) {
            ModalKeyStep::Close => self.prompt = PromptState::None,
            ModalKeyStep::MoveFocus(step) => prompt.move_focus(step),
            ModalKeyStep::Confirm | ModalKeyStep::ActivateFocus => {
                self.activate_jcode_models_focus();
            }
            ModalKeyStep::FallThroughToField => match action {
                Some(Action::MoveDown) => prompt.move_focus(FocusStep::Forward),
                Some(Action::MoveUp) => prompt.move_focus(FocusStep::Backward),
                _ if field == TextFieldFocus::Field => {
                    prompt.model.handle_key(key);
                }
                _ => {}
            },
        }
        false
    }

    pub(super) fn press_jcode_models_focus(&mut self, focus: ModelsFocus) {
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            prompt.focus = focus;
        }
        self.activate_jcode_models_focus();
    }
}

#[cfg(test)]
#[path = "jcode_models_tests.rs"]
mod tests;
