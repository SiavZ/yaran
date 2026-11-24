//! Mouse scrolling for the model picker and its per-tab result report.

use super::input::{contains_point, cursor_from_single_line_click};
use super::jcode_models::ModelsFocus;
use super::{App, OverlayMouseLayout, PromptState};
use ratatui::crossterm::event::{MouseEvent, MouseEventKind};

impl App {
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
        if prompt.loading {
            return Some(false);
        }
        let OverlayMouseLayout::JcodeModels { list, .. } = self.overlay_layout.active else {
            return Some(false);
        };
        if contains_point(list, mouse.column, mouse.row) {
            self.pressed_button = None;
            let count = prompt.picker_rows().len();
            if let Some(picker) = &mut prompt.picking {
                picker.selected = if down {
                    (picker.selected + 1).min(count.saturating_sub(1))
                } else {
                    picker.selected.saturating_sub(1)
                };
            } else if prompt.outcomes.is_some() {
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
        if let PromptState::JcodeModels(prompt) = &mut self.prompt
            && let Some(picker) = &mut prompt.picking
        {
            picker.filter.cursor = cursor_from_single_line_click(
                &picker.filter.text,
                picker.filter.cursor,
                input,
                8,
                column,
            );
        }
    }
}
