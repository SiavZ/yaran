//! Mouse scrolling for the model picker and its per-tab result report.

use super::input::{contains_point, cursor_from_single_line_click};
use super::jcode_models::ModelsFocus;
use super::{App, OverlayMouseLayout, PromptState};
use crate::keybindings::{Action, BindingScope};
use ratatui::crossterm::event::{KeyCode, KeyEvent, MouseEvent, MouseEventKind};

impl App {
    pub(super) fn handle_jcode_models_results_key(&mut self, key: KeyEvent) -> bool {
        let action = self
            .bindings
            .lookup(&key, BindingScope::Dialog)
            .or_else(|| self.bindings.lookup(&key, BindingScope::Help));
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return false;
        };
        match action {
            Some(Action::CloseOverlay | Action::Confirm) => self.prompt = PromptState::None,
            Some(Action::MoveDown) => {
                prompt.scroll.offset = prompt
                    .scroll
                    .offset
                    .saturating_add(1)
                    .min(prompt.scroll.max_offset());
            }
            Some(Action::MoveUp) => prompt.scroll.offset = prompt.scroll.offset.saturating_sub(1),
            Some(Action::ScrollPageDown) => {
                prompt.scroll.offset = prompt
                    .scroll
                    .offset
                    .saturating_add(prompt.scroll.viewport)
                    .min(prompt.scroll.max_offset());
            }
            Some(Action::ScrollPageUp) => {
                prompt.scroll.offset = prompt.scroll.offset.saturating_sub(prompt.scroll.viewport);
            }
            Some(Action::ScrollToTop) => prompt.scroll.offset = 0,
            Some(Action::ScrollToBottom) => prompt.scroll.offset = prompt.scroll.max_offset(),
            _ if key.code == KeyCode::Char(' ') => self.prompt = PromptState::None,
            _ => {}
        }
        false
    }

    pub(super) fn handle_jcode_models_wheel(&mut self, mouse: MouseEvent) -> Option<bool> {
        let PromptState::JcodeModels(prompt) = &mut self.prompt else {
            return None;
        };
        if prompt.busy {
            return Some(false);
        }
        let down = match mouse.kind {
            MouseEventKind::ScrollDown => true,
            MouseEventKind::ScrollUp => false,
            _ => return None,
        };
        let OverlayMouseLayout::JcodeModels { list, .. } = self.overlay_layout.active else {
            return Some(false);
        };
        if contains_point(list, mouse.column, mouse.row) {
            self.pressed_button = None;
            if prompt.outcomes.is_some() {
                prompt.scroll.offset = if down {
                    prompt
                        .scroll
                        .offset
                        .saturating_add(3)
                        .min(prompt.scroll.max_offset())
                } else {
                    prompt.scroll.offset.saturating_sub(3)
                };
            } else if !prompt.targets.is_empty() {
                let index = match prompt.focus {
                    ModelsFocus::Target(i) => i,
                    _ => 0,
                };
                prompt.focus = ModelsFocus::Target(if down {
                    (index + 1).min(prompt.targets.len() - 1)
                } else {
                    index.saturating_sub(1)
                });
            }
        }
        Some(false)
    }

    pub(super) fn click_jcode_models_input(&mut self, column: u16) {
        let OverlayMouseLayout::JcodeModels { input, .. } = self.overlay_layout.active else {
            return;
        };
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            prompt.focus = ModelsFocus::Model;
            prompt.model.cursor = cursor_from_single_line_click(
                &prompt.model.text,
                prompt.model.cursor,
                input,
                10,
                column,
            );
        }
    }
}
