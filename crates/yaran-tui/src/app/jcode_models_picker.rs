//! Native catalog loading and the model/provider and reasoning pickers.

use super::components::FocusStep;
use super::jcode_models::{ModelsFocus, ModelsPicker, ModelsPickerKind, ModelsPrompt};
use super::modal::{ModalKeyStep, TextFieldFocus, binding_lookup_is_suppressed, modal_key_step};
use super::text_input::TextInput;
use super::ui_jobs::{RequestKind, UiJob};
use super::{App, PromptState};
use crate::keybindings::{Action, BindingScope};
use ratatui::crossterm::event::KeyEvent;
use yaran_core::jcode_models::model_catalog;

impl ModelsPrompt {
    pub(super) fn picker_rows(&self) -> Vec<(usize, String, bool)> {
        let Some(picker) = &self.picking else {
            return Vec::new();
        };
        let filter = picker.filter.text.to_lowercase();
        let rows: Vec<_> = match picker.kind {
            ModelsPickerKind::Model => self
                .choices
                .iter()
                .enumerate()
                .map(|(index, choice)| {
                    (
                        index,
                        format!(
                            "{} · {} · {}",
                            choice.name, choice.provider, choice.api_method
                        ),
                        choice.available,
                    )
                })
                .collect(),
            ModelsPickerKind::Reasoning => self
                .chosen()
                .map(|choice| {
                    choice
                        .reasoning_levels
                        .iter()
                        .enumerate()
                        .map(|(index, level)| (index, level.label.clone(), true))
                        .collect()
                })
                .unwrap_or_default(),
        };
        rows.into_iter()
            .filter(|(_, label, _)| label.to_lowercase().contains(&filter))
            .map(|(index, label, enabled)| {
                (index, yaran_core::sanitize::for_terminal(&label), enabled)
            })
            .collect()
    }
}

impl App {
    pub(super) fn load_jcode_model_choices(&mut self) {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return;
        };
        let selected = prompt.selected_runs();
        if selected.is_empty() {
            prompt.error = Some("Select running jcodes first.".into());
            return;
        }
        let targets = self.engine.jcode_model_targets();
        prompt.loading = true;
        prompt.error = None;
        let request = self.ui_jobs.begin_request(RequestKind::JcodeModels);
        self.spawn_ui_job(
            UiJob {
                busy: "Loading native jcode model choices...".into(),
                stopped: "The native model catalog worker stopped.".into(),
            },
            move || model_catalog(&targets, &selected),
            move |app, answer| {
                if !app.ui_jobs.is_newest(RequestKind::JcodeModels, request) {
                    return;
                }
                let PromptState::JcodeModels(prompt) = &mut app.prompt else {
                    return;
                };
                if !prompt.loading {
                    return;
                }
                prompt.loading = false;
                match answer {
                    Some(Ok(choices)) => {
                        prompt.choices = choices;
                        prompt.choice = None;
                        prompt.reasoning = None;
                        let selected = prompt
                            .choices
                            .iter()
                            .position(|choice| choice.available)
                            .unwrap_or(0);
                        prompt.picking = Some(ModelsPicker {
                            kind: ModelsPickerKind::Model,
                            filter: TextInput::new(),
                            selected,
                        });
                        prompt.focus = ModelsFocus::Model;
                        if prompt.choices.is_empty() {
                            prompt.error = Some(
                                "No shared model/provider routes. Select fewer jcodes and retry."
                                    .into(),
                            );
                        }
                    }
                    Some(Err(error)) => prompt.error = Some(error.to_string()),
                    None => prompt.error = Some("The native model catalog worker stopped.".into()),
                }
            },
        );
    }

    pub(super) fn choose_jcode_model_option(&mut self) {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return;
        };
        let Some(picker) = &prompt.picking else {
            return;
        };
        let kind = picker.kind;
        let Some((index, _, enabled)) = prompt.picker_rows().get(picker.selected).cloned() else {
            return;
        };
        if !enabled {
            prompt.error = Some(prompt.choices[index].detail.clone());
            return;
        }
        match kind {
            ModelsPickerKind::Model => {
                prompt.choice = Some(index);
                prompt
                    .reasoning
                    .clone_from(&prompt.choices[index].reasoning_effort);
                prompt.focus = ModelsFocus::Model;
            }
            ModelsPickerKind::Reasoning => {
                prompt.reasoning = prompt
                    .chosen()
                    .and_then(|choice| choice.reasoning_levels.get(index))
                    .map(|level| level.value.clone());
                prompt.focus = ModelsFocus::Reasoning;
            }
        }
        prompt.error = None;
        prompt.picking = None;
    }

    pub(super) fn handle_jcode_model_picker_key(&mut self, key: KeyEvent) -> bool {
        let action = if binding_lookup_is_suppressed(key, TextFieldFocus::Field, self.extended_keys)
        {
            None
        } else {
            self.bindings
                .lookup(&key, BindingScope::Dialog)
                .or_else(|| self.bindings.lookup(&key, BindingScope::Help))
        };
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return false;
        };
        let page = match self.overlay_layout.active {
            super::OverlayMouseLayout::JcodeModels { list, .. } => usize::from(list.height).max(1),
            _ => 1,
        };
        let count = prompt.picker_rows().len();
        let Some(picker) = &mut prompt.picking else {
            return false;
        };
        match modal_key_step(action, key, TextFieldFocus::Field) {
            ModalKeyStep::Close => prompt.picking = None,
            ModalKeyStep::Confirm | ModalKeyStep::ActivateFocus => self.choose_jcode_model_option(),
            ModalKeyStep::MoveFocus(step) => match step {
                FocusStep::Forward => {
                    picker.selected = (picker.selected + 1).min(count.saturating_sub(1));
                }
                FocusStep::Backward => picker.selected = picker.selected.saturating_sub(1),
            },
            ModalKeyStep::FallThroughToField => match action {
                Some(Action::MoveDown) => {
                    picker.selected = (picker.selected + 1).min(count.saturating_sub(1));
                }
                Some(Action::MoveUp) => picker.selected = picker.selected.saturating_sub(1),
                Some(Action::ScrollPageDown) => {
                    picker.selected = picker
                        .selected
                        .saturating_add(page)
                        .min(count.saturating_sub(1));
                }
                Some(Action::ScrollPageUp) => {
                    picker.selected = picker.selected.saturating_sub(page);
                }
                _ => {
                    picker.filter.handle_key(key);
                    picker.selected = 0;
                }
            },
        }
        false
    }
}
