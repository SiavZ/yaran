//! Keys and clicks for the Yaran Cloud modals.
//!
//! The modal ladder decides what a key means (`modal_key_step`): Escape closes (and
//! cancels a running login), Enter submits the login or acts on the focused confirm
//! button, Space acts on a focused button and is typed into the login's field.
//!
//! - A click lands the login's caret, or arms a confirm button that acts on release.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_input.rs
//! ├── app
//! ├── app::cloud_commands
//! ├── app::input
//! └── app::modal
//! External: crossterm
//!
//! Used by:
//! app/cloud_input.rs
//! └── app
//! <module-headers:end>

use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};

use super::cloud_commands::CloudPrompt;
use super::input::{contains_point, cursor_from_single_line_position};
use super::modal::{ModalKeyStep, binding_lookup_is_suppressed, click_target, modal_key_step};
use super::*;

/// What a key does, decided before anything is mutated.
enum CloudKey {
    Close,
    Submit,
    Type,
    ToggleFocus,
    Resolve,
    Nothing,
}

impl App {
    pub(crate) fn handle_cloud_prompt_key(&mut self, key: KeyEvent) -> Option<bool> {
        let PromptState::Cloud(prompt) = &self.prompt else {
            return None;
        };
        let field = matches!(prompt, CloudPrompt::Login(_));
        let action = if binding_lookup_is_suppressed(key, field) {
            None
        } else {
            self.bindings.lookup(&key, BindingScope::Dialog)
        };
        let todo = match (prompt, modal_key_step(action, key, field)) {
            (_, ModalKeyStep::Close) => CloudKey::Close,
            (CloudPrompt::Login(_), ModalKeyStep::Confirm) => CloudKey::Submit,
            (CloudPrompt::Login(_), ModalKeyStep::FallThroughToField) => CloudKey::Type,
            (CloudPrompt::Logout(_) | CloudPrompt::Rotate(_), ModalKeyStep::MoveFocus(_)) => {
                CloudKey::ToggleFocus
            }
            (
                CloudPrompt::Logout(_) | CloudPrompt::Rotate(_),
                ModalKeyStep::Confirm | ModalKeyStep::ActivateFocus,
            ) => CloudKey::Resolve,
            (
                CloudPrompt::Status(_) | CloudPrompt::PairPhone(_),
                ModalKeyStep::Confirm | ModalKeyStep::ActivateFocus,
            ) => CloudKey::Close,
            _ => CloudKey::Nothing,
        };
        self.cloud.pressed = None;
        match (todo, &mut self.prompt) {
            (CloudKey::Close, _) => self.cancel_cloud_prompt(),
            (CloudKey::Submit, _) => self.submit_cloud_login(),
            (CloudKey::Type, PromptState::Cloud(CloudPrompt::Login(login))) => {
                login.field_mut().handle_key(key);
            }
            (
                CloudKey::ToggleFocus,
                PromptState::Cloud(CloudPrompt::Logout(focus) | CloudPrompt::Rotate(focus)),
            ) => *focus = focus.toggled(),
            (
                CloudKey::Resolve,
                PromptState::Cloud(CloudPrompt::Logout(focus) | CloudPrompt::Rotate(focus)),
            ) => {
                let confirm = focus.is_confirm();
                self.resolve_cloud_confirm(confirm);
            }
            _ => {}
        }
        Some(false)
    }

    /// A click lands the login's caret, or presses a confirm's button (acting on
    /// the release over the same button). Anything else falls through to the
    /// generic outside-click handling.
    pub(crate) fn handle_cloud_mouse(&mut self, mouse: &MouseEvent) -> Option<bool> {
        let OverlayMouseLayout::Cloud {
            field,
            cancel,
            confirm,
        } = self.overlay_layout.active
        else {
            return None;
        };
        let PromptState::Cloud(prompt) = &mut self.prompt else {
            return None;
        };
        let buttons: Vec<(Rect, ConfirmFocus)> = [
            cancel.map(|r| (r, ConfirmFocus::Cancel)),
            confirm.map(|r| (r, ConfirmFocus::Confirm)),
        ]
        .into_iter()
        .flatten()
        .collect();
        let hit = click_target(&buttons, mouse.column, mouse.row);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if let (Some(rect), CloudPrompt::Login(login)) = (field, &mut *prompt)
                    && contains_point(rect, mouse.column, mouse.row)
                {
                    let input = login.field_mut();
                    input.cursor =
                        cursor_from_single_line_position(&input.text, rect, 1, mouse.column);
                    return Some(false);
                }
                let button = hit?;
                if let CloudPrompt::Logout(focus) | CloudPrompt::Rotate(focus) = prompt {
                    *focus = button;
                }
                self.cloud.pressed = Some(button);
                Some(false)
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let pressed = self.cloud.pressed.take()?;
                if hit == Some(pressed) {
                    self.resolve_cloud_confirm(pressed.is_confirm());
                }
                Some(false)
            }
            _ => None,
        }
    }
}
