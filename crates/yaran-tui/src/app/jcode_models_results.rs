//! Scrollable per-tab model change outcomes, including partial failures.

use super::components::button::{
    Button, ButtonPressedTarget, ButtonState, button_state_for, shared_button_width,
};
use super::components::hint_bar::{Hint, modal_hint_line};
use super::components::{render_scroll_view, wrap_styled_lines};
use super::render::centered_rect_exact;
use super::{App, OverlayMouseLayout, PromptState};
use crate::keybindings::{Action, BindingScope};
use ratatui::crossterm::event::{KeyCode, KeyEvent};
use ratatui::{
    Frame,
    layout::Rect,
    text::Line,
    widgets::{Paragraph, Widget},
};

impl App {
    pub(super) fn render_jcode_models_results(&mut self, frame: &mut Frame<'_>) {
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
        let mut lines = vec![Line::from(if prompt.loading {
            "Loading native model/provider/reasoning choices..."
        } else if prompt.busy {
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
                        outcome.error.as_deref().unwrap_or("Native choice applied.")
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
        let mut hints = Vec::new();
        if !prompt.busy {
            if !prompt.loading && scroll.scrollable() {
                hints.push(Hint::key(
                    self.bindings.label_for(Action::MoveDown),
                    "scroll",
                ));
            }
            hints.push(Hint::key(self.bindings.label_for(Action::CloseOverlay), "close").pinned());
        }
        Paragraph::new(modal_hint_line(&self.theme, &hints, inner.width)).render(
            Rect::new(inner.x, inner.bottom().saturating_sub(1), inner.width, 1),
            frame.buffer_mut(),
        );
        if let PromptState::JcodeModels(prompt) = &mut self.prompt {
            prompt.scroll = scroll;
        }
        self.overlay_layout.active = OverlayMouseLayout::JcodeModels {
            input: Rect::default(),
            model: Rect::default(),
            reasoning: Rect::default(),
            all: Rect::default(),
            list,
            items: 0,
            offset: 0,
            apply: Rect::default(),
            cancel,
        };
    }
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
}
