//! The bulk jcode model form, using the shared field, checkbox, list and buttons.

use super::components::ButtonState;
use super::components::button::{
    Button, ButtonPressedTarget, button_row, button_state_for, shared_button_width,
};
use super::components::checkbox::{Checkbox, CheckboxState};
use super::components::hint_bar::{Hint, modal_hint_line};
use super::components::picker_list::PickerList;
use super::components::{render_scroll_view, wrap_styled_lines};
use super::jcode_models::ModelsFocus;
use super::render::{centered_rect_exact, render_single_line_field};
use super::{App, OverlayMouseLayout, PromptState};
use crate::keybindings::Action;
use crate::theme::FocusState;
use ratatui::{
    Frame,
    layout::Rect,
    text::Line,
    widgets::{ListItem, Paragraph, Widget, Wrap},
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
        if prompt.busy || prompt.outcomes.is_some() {
            self.render_jcode_models_results(frame);
            return;
        }
        let prompt = prompt.clone();
        let area = centered_rect_exact(78, 24, frame.area());
        let inner = self
            .open_modal_frame(frame, "Change jcode models", area)
            .inner;
        if inner.height < 12 {
            return;
        }
        let width = inner.width.saturating_sub(2);
        let x = inner.x + 1;
        if let Some(error) = &prompt.error {
            Paragraph::new(error.as_str())
                .wrap(Wrap { trim: false })
                .style(ratatui::style::Style::default().fg(self.theme.status_error_fg))
                .render(Rect::new(x, inner.y, width, 3), frame.buffer_mut());
        } else {
            Paragraph::new("Choose running jcodes and enter a model ID.")
                .render(Rect::new(x, inner.y, width, 1), frame.buffer_mut());
            Paragraph::new(
                "Conversations and drafts stay in place; jcode control must be enabled.",
            )
            .render(Rect::new(x, inner.y + 1, width, 1), frame.buffer_mut());
            Paragraph::new("jcode's model indicator may need a tab reconnect to refresh.")
                .render(Rect::new(x, inner.y + 2, width, 1), frame.buffer_mut());
        }
        let input = Rect::new(x, inner.y + 3, width, 1);
        Paragraph::new(render_single_line_field(
            "Model ID: ",
            &prompt.model.text,
            prompt.model.cursor,
            self.theme.input_cursor_fg,
            self.theme.input_cursor_bg,
            FocusState::from(prompt.focus == ModelsFocus::Model),
            width,
        ))
        .render(input, frame.buffer_mut());
        let all = Rect::new(x, inner.y + 5, width, 1);
        let text = ratatui::style::Style::default().fg(self.theme.text_fg);
        let checkbox = Checkbox::new("All running jcodes")
            .checked(
                (!prompt.targets.is_empty() && prompt.selected.len() == prompt.targets.len())
                    .into(),
            )
            .state(CheckboxState::of(prompt.focus, ModelsFocus::All));
        Paragraph::new(checkbox.layout(width, text, text).lines).render(all, frame.buffer_mut());
        let list_area = Rect::new(x, inner.y + 7, width, inner.height.saturating_sub(12));
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
        let selected = match prompt.focus {
            ModelsFocus::Target(i) => Some(i),
            _ => None,
        };
        let layout = PickerList::new(rows, selected, "No running jcode tabs.")
            .indicator_frame(area)
            .render(frame, list_area, &self.theme);
        let buttons = Rect::new(x, inner.bottom().saturating_sub(4), width, 3);
        let [cancel, apply] =
            button_row(buttons, shared_button_width(&["Cancel", "Change models"]));
        for (rect, label, focus, target) in [
            (
                cancel,
                "Cancel",
                ModelsFocus::Cancel,
                ButtonPressedTarget::JcodeModelsCancel,
            ),
            (
                apply,
                "Change models",
                ModelsFocus::Apply,
                ButtonPressedTarget::JcodeModelsApply,
            ),
        ] {
            let state = if focus == ModelsFocus::Apply
                && (prompt.selected.is_empty() || prompt.model.text.trim().is_empty())
            {
                ButtonState::Disabled
            } else if prompt.focus == focus {
                ButtonState::Focused
            } else {
                ButtonState::Normal
            };
            Button::new(label)
                .state(button_state_for(target, self.pressed_button, state))
                .render(frame, rect, &self.theme);
        }
        let label = |action| {
            if prompt.focus == ModelsFocus::Model {
                self.bindings.label_for_text_field_dialog(action)
            } else {
                Some(self.bindings.label_for(action))
            }
        };
        let hints = [
            Hint::maybe_key(label(Action::ToggleSelection), "focus"),
            Hint::maybe_key(label(Action::Confirm), "choose"),
            Hint::maybe_key(label(Action::CloseOverlay), "close").pinned(),
        ];
        Paragraph::new(modal_hint_line(&self.theme, &hints, width)).render(
            Rect::new(x, inner.bottom().saturating_sub(1), width, 1),
            frame.buffer_mut(),
        );
        self.overlay_layout.active = OverlayMouseLayout::JcodeModels {
            input,
            all,
            list: layout.list,
            items: layout.items,
            offset: layout.offset,
            apply,
            cancel,
        };
    }

    fn render_jcode_models_results(&mut self, frame: &mut Frame<'_>) {
        let PromptState::JcodeModels(prompt) = &self.prompt else {
            return;
        };
        let prompt = prompt.clone();
        let area = centered_rect_exact(78, 24, frame.area());
        let inner = self
            .open_modal_frame(frame, "jcode model results", area)
            .inner;
        let list = Rect::new(
            inner.x + 1,
            inner.y,
            inner.width.saturating_sub(2),
            inner.height.saturating_sub(5),
        );
        let mut lines = vec![Line::from(if prompt.busy {
            "Changing the selected jcode models..."
        } else {
            "Conversations and drafts are preserved."
        })];
        if let Some(outcomes) = &prompt.outcomes {
            for outcome in outcomes {
                let style = ratatui::style::Style::default().fg(if outcome.error.is_some() {
                    self.theme.status_error_fg
                } else {
                    self.theme.text_fg
                });
                lines.push(Line::from(""));
                lines.push(Line::styled(
                    format!(
                        "{}  {}: {}",
                        outcome.label,
                        outcome.tab_id,
                        outcome.error.as_deref().unwrap_or("Model changed.")
                    ),
                    style,
                ));
            }
        }
        let lines = wrap_styled_lines(&lines, usize::from(list.width));
        let scroll =
            render_scroll_view(frame, area, list, lines, prompt.scroll.offset, &self.theme);
        let buttons = Rect::new(inner.x, inner.bottom().saturating_sub(4), inner.width, 3);
        let width = shared_button_width(&["Close"]);
        let cancel = Rect::new(
            buttons.x + buttons.width.saturating_sub(width) / 2,
            buttons.y,
            width,
            3,
        );
        Button::new("Close")
            .state(button_state_for(
                ButtonPressedTarget::JcodeModelsCancel,
                self.pressed_button,
                if prompt.busy {
                    ButtonState::Disabled
                } else {
                    ButtonState::Focused
                },
            ))
            .render(frame, cancel, &self.theme);
        let hints = [
            Hint::key(self.bindings.label_for(Action::MoveDown), "scroll"),
            Hint::key(self.bindings.label_for(Action::CloseOverlay), "close").pinned(),
        ];
        Paragraph::new(modal_hint_line(&self.theme, &hints, inner.width)).render(
            Rect::new(inner.x, inner.bottom().saturating_sub(1), inner.width, 1),
            frame.buffer_mut(),
        );
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            prompt.scroll = scroll;
        }
        self.overlay_layout.active = OverlayMouseLayout::JcodeModels {
            input: Rect::default(),
            all: Rect::default(),
            list,
            items: 0,
            offset: 0,
            apply: Rect::default(),
            cancel,
        };
    }
}
