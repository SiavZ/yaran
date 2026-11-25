//! Shared widgets for the bulk jcode form and its native-choice pickers.

use super::components::button::{
    Button, ButtonPressedTarget, ButtonState, button_row, button_state_for, shared_button_width,
};
use super::components::checkbox::{Checkbox, CheckboxState};
use super::components::ellipsis::ellipsize_end;
use super::components::hint_bar::{Hint, modal_hint_line};
use super::components::picker_list::PickerList;
use super::components::wrap_styled_lines;
use super::jcode_models::{ModelsFocus, ModelsPickerKind};
use super::render::{centered_rect_exact, render_single_line_field};
use super::{App, OverlayMouseLayout, PromptState};
use crate::keybindings::Action;
use crate::theme::FocusState;
use ratatui::{
    Frame,
    layout::Rect,
    text::Text,
    widgets::{ListItem, Paragraph, Widget},
};

impl App {
    #[expect(
        clippy::too_many_lines,
        reason = "one form layout publishes the same rectangles for drawing and mouse routing"
    )]
    pub(super) fn render_jcode_models(&mut self, frame: &mut Frame<'_>) {
        let PromptState::JcodeModels(prompt) = &self.prompt else {
            return;
        };
        if prompt.busy || prompt.loading || prompt.outcomes.is_some() {
            self.render_jcode_models_results(frame);
            return;
        }
        if prompt.picking.is_some() {
            self.render_jcode_model_picker(frame);
            return;
        }
        let prompt = prompt.clone();
        let area = centered_rect_exact(78, 24, frame.area());
        let inner = self
            .open_modal_frame(frame, "Change jcode models", area)
            .inner;
        if inner.height < 17 {
            return;
        }
        let width = inner.width.saturating_sub(2);
        let x = inner.x + 1;
        if let Some(error) = &prompt.error {
            Paragraph::new(wrap_styled_lines(
                &Text::raw(error.as_str()).lines,
                usize::from(width),
            ))
            .style(ratatui::style::Style::default().fg(self.theme.status_error_fg))
            .render(Rect::new(x, inner.y, width, 3), frame.buffer_mut());
        } else {
            Paragraph::new("Select jcodes, then choose from their native /models catalog.")
                .render(Rect::new(x, inner.y, width, 1), frame.buffer_mut());
            Paragraph::new("Provider routes and reasoning levels stay together.")
                .render(Rect::new(x, inner.y + 1, width, 1), frame.buffer_mut());
        }
        let model = Rect::new(x, inner.y + 3, width, 3);
        let reasoning = Rect::new(x, inner.y + 6, width, 3);
        let all = Rect::new(x, inner.y + 10, width, 1);
        let text = ratatui::style::Style::default().fg(self.theme.text_fg);
        let checkbox = Checkbox::new("All running jcodes")
            .checked(
                (!prompt.targets.is_empty() && prompt.selected.len() == prompt.targets.len())
                    .into(),
            )
            .state(CheckboxState::of(prompt.focus, ModelsFocus::All));
        Paragraph::new(checkbox.layout(width, text, text).lines).render(all, frame.buffer_mut());
        let list_area = Rect::new(x, inner.y + 12, width, inner.height.saturating_sub(17));
        let rows = prompt
            .targets
            .iter()
            .enumerate()
            .map(|(i, target)| {
                let label = format!("{}  {}", target.label, target.tab_id);
                let checkbox = Checkbox::new(&label)
                    .checked(prompt.selected.contains(&target.tab_id).into())
                    .state(CheckboxState::of(prompt.focus, ModelsFocus::Target(i)));
                ListItem::new(checkbox.layout(u16::MAX, text, text).lines)
            })
            .collect();
        let selected = if let ModelsFocus::Target(i) = prompt.focus {
            Some(i)
        } else {
            None
        };
        let layout = PickerList::new(rows, selected, "No running jcode tabs.")
            .indicator_frame(area)
            .render(frame, list_area, &self.theme);
        let buttons = Rect::new(x, inner.bottom().saturating_sub(4), width, 3);
        let [cancel, apply] =
            button_row(buttons, shared_button_width(&["Cancel", "Change models"]));
        let model_label = prompt.chosen().map_or_else(
            || "Choose model and provider".into(),
            |choice| {
                format!(
                    "Model: {} · {} · {}",
                    choice.name, choice.provider, choice.api_method
                )
            },
        );
        let reasoning_label = prompt.chosen().map_or_else(
            || "Choose a model first".into(),
            |choice| {
                choice
                    .reasoning_levels
                    .iter()
                    .find(|level| Some(&level.value) == prompt.reasoning.as_ref())
                    .map_or_else(
                        || "No reasoning choice for this route".into(),
                        |level| format!("Reasoning: {}", level.label),
                    )
            },
        );
        for (rect, label, focus, target, enabled) in [
            (
                model,
                model_label.as_str(),
                ModelsFocus::Model,
                ButtonPressedTarget::JcodeModelsModel,
                !prompt.selected.is_empty(),
            ),
            (
                reasoning,
                reasoning_label.as_str(),
                ModelsFocus::Reasoning,
                ButtonPressedTarget::JcodeModelsReasoning,
                prompt
                    .chosen()
                    .is_some_and(|choice| !choice.reasoning_levels.is_empty()),
            ),
            (
                cancel,
                "Cancel",
                ModelsFocus::Cancel,
                ButtonPressedTarget::JcodeModelsCancel,
                true,
            ),
            (
                apply,
                "Change models",
                ModelsFocus::Apply,
                ButtonPressedTarget::JcodeModelsApply,
                prompt.can_apply(),
            ),
        ] {
            let state = if !enabled {
                ButtonState::Disabled
            } else if prompt.focus == focus {
                ButtonState::Focused
            } else {
                ButtonState::Normal
            };
            let label = ellipsize_end(
                &yaran_core::sanitize::for_terminal(label),
                usize::from(rect.width.saturating_sub(4)),
            );
            Button::new(&label)
                .state(button_state_for(target, self.pressed_button, state))
                .render(frame, rect, &self.theme);
        }
        let hints = [
            Hint::key(self.bindings.label_for(Action::ToggleSelection), "focus"),
            Hint::key(self.bindings.label_for(Action::Confirm), "choose"),
            Hint::key(self.bindings.label_for(Action::CloseOverlay), "close").pinned(),
        ];
        Paragraph::new(modal_hint_line(&self.theme, &hints, width)).render(
            Rect::new(x, inner.bottom().saturating_sub(1), width, 1),
            frame.buffer_mut(),
        );
        self.overlay_layout.active = OverlayMouseLayout::JcodeModels {
            input: Rect::default(),
            model,
            reasoning,
            all,
            list: layout.list,
            items: layout.items,
            offset: layout.offset,
            apply,
            cancel,
        };
    }

    fn render_jcode_model_picker(&mut self, frame: &mut Frame<'_>) {
        let PromptState::JcodeModels(prompt) = &self.prompt else {
            return;
        };
        let prompt = prompt.clone();
        let Some(picker) = &prompt.picking else {
            return;
        };
        let title = match picker.kind {
            ModelsPickerKind::Model => "Choose model and provider",
            ModelsPickerKind::Reasoning => "Choose reasoning level",
        };
        let area = centered_rect_exact(78, 24, frame.area());
        let inner = self.open_modal_frame(frame, title, area).inner;
        if inner.height < 10 {
            return;
        }
        let width = inner.width.saturating_sub(2);
        let x = inner.x + 1;
        let message = prompt
            .error
            .as_deref()
            .unwrap_or("Native /models choices shared by the selected jcodes.");
        Paragraph::new(wrap_styled_lines(
            &Text::raw(message).lines,
            usize::from(width),
        ))
        .style(
            ratatui::style::Style::default().fg(if prompt.error.is_some() {
                self.theme.status_error_fg
            } else {
                self.theme.text_fg
            }),
        )
        .render(Rect::new(x, inner.y, width, 3), frame.buffer_mut());
        let input = Rect::new(x, inner.y + 3, width, 1);
        Paragraph::new(render_single_line_field(
            "Filter: ",
            &picker.filter.text,
            picker.filter.cursor,
            self.theme.input_cursor_fg,
            self.theme.input_cursor_bg,
            FocusState::from(true),
            width,
        ))
        .render(input, frame.buffer_mut());
        let rows = prompt
            .picker_rows()
            .into_iter()
            .map(|(_, label, enabled)| {
                ListItem::new(label).style(ratatui::style::Style::default().fg(if enabled {
                    self.theme.text_fg
                } else {
                    self.theme.warning_fg
                }))
            })
            .collect();
        let list = Rect::new(x, inner.y + 5, width, inner.height.saturating_sub(10));
        let layout = PickerList::new(rows, Some(picker.selected), "No matching native choices.")
            .indicator_frame(area)
            .render(frame, list, &self.theme);
        let button_width = shared_button_width(&["Back"]);
        let cancel = Rect::new(
            x + width.saturating_sub(button_width) / 2,
            inner.bottom().saturating_sub(4),
            button_width,
            3,
        );
        Button::new("Back")
            .state(button_state_for(
                ButtonPressedTarget::JcodeModelsCancel,
                self.pressed_button,
                ButtonState::Normal,
            ))
            .render(frame, cancel, &self.theme);
        let label = |action| self.bindings.label_for_text_field_dialog(action);
        let hints = [
            Hint::maybe_key(label(Action::MoveDown), "browse"),
            Hint::maybe_key(label(Action::Confirm), "choose"),
            Hint::maybe_key(label(Action::CloseOverlay), "back").pinned(),
        ];
        Paragraph::new(modal_hint_line(&self.theme, &hints, width)).render(
            Rect::new(x, inner.bottom().saturating_sub(1), width, 1),
            frame.buffer_mut(),
        );
        self.overlay_layout.active = OverlayMouseLayout::JcodeModels {
            input,
            model: Rect::default(),
            reasoning: Rect::default(),
            all: Rect::default(),
            list: layout.list,
            items: layout.items,
            offset: layout.offset,
            apply: Rect::default(),
            cancel,
        };
    }
}
