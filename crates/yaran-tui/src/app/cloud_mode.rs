//! The `set-cloud-mode` picker and the terminal UI's half of a live `[cloud] mode`
//! change: save, ask the background serve's companion, and resolve the status op when
//! the serve answers on the worker lane.
//!
//! Modelled on the Tailscale picker (Picker family: three rows, the saved one marked,
//! picking one applies it). In background mode the terminal UI is also the reload owner,
//! so `apply_cloud_reload` is called from `apply_reloaded_config`.
//!
//! - Every sentence comes from `yaran_core::cloud::leg_outcome`, so the web row and this
//!   picker say the same words.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_mode.rs
//! ├── app
//! ├── app::render
//! ├── app::test_support
//! ├── yaran-core::cloud::leg_identity
//! ├── yaran-core::cloud::leg_outcome
//! ├── yaran-core::engine
//! └── yaran-core::engine::status_op
//! External: none
//!
//! Used by:
//! app/cloud_mode.rs
//! └── app
//! <module-headers:end>

use super::*;
use crate::app::render::{active_provider_marker_span, centered_rect};
use yaran_core::cloud::leg_identity::{CloudLegSettings, CloudMode};
use yaran_core::cloud::leg_outcome::CloudModeOutcome;

/// One row of the cloud-mode picker.
#[derive(Clone, Debug)]
pub(crate) struct SetCloudModeOption {
    pub(crate) mode: CloudMode,
    pub(crate) is_current: bool,
}

/// The `[cloud] mode` picker.
#[derive(Clone, Debug)]
pub(crate) struct SetCloudModePrompt {
    pub(crate) current: CloudMode,
    pub(crate) options: Vec<SetCloudModeOption>,
    pub(crate) selected: usize,
    /// Whether a background serve is up, captured when the picker opens.
    pub(crate) serving: bool,
}

fn meaning(mode: CloudMode) -> &'static str {
    match mode {
        CloudMode::Auto => "run the tunnel whenever this machine is paired and yaran serves",
        CloudMode::Yes => "the same, and warn when this machine is not paired",
        CloudMode::No => "never run it; the pairing is kept",
    }
}

fn final_for(report: yaran_core::cloud::leg_outcome::CloudModeReport) -> yaran_core::engine::Final {
    if report.warning {
        yaran_core::engine::Final::warning(report.message)
    } else {
        yaran_core::engine::Final::info(report.message)
    }
}

impl App {
    pub(crate) fn open_set_cloud_mode_prompt(&mut self) {
        let current =
            yaran_core::cloud::leg_identity::settings_from_config(&self.engine.config).mode;
        let options: Vec<_> = CloudMode::ALL
            .into_iter()
            .map(|mode| SetCloudModeOption {
                mode,
                is_current: mode == current,
            })
            .collect();
        let selected = options.iter().position(|o| o.is_current).unwrap_or(0);
        let serving = self.background_server_is_serving();
        self.input_target = InputTarget::None;
        self.fullscreen_overlay = FullscreenOverlay::None;
        self.prompt = PromptState::SetCloudMode(SetCloudModePrompt {
            current,
            options,
            selected,
            serving,
        });
        self.set_prompt_hint(if serving {
            "Choose whether yaran runs its Cloudflare tunnel. The choice is saved to config.toml \
             and applied to the serve that is running right now."
                .to_string()
        } else {
            "Choose whether yaran runs its Cloudflare tunnel. Nothing is serving, so the choice is \
             saved to config.toml and applies the next time a listener starts."
                .to_string()
        });
    }

    pub(crate) fn apply_set_cloud_mode(&mut self) {
        let picked = match &self.prompt {
            PromptState::SetCloudMode(prompt) => {
                prompt.options.get(prompt.selected).map(|o| o.mode)
            }
            _ => return,
        };
        self.prompt = PromptState::None;
        self.clear_prompt_hint();
        match picked {
            Some(mode) => self.save_and_apply_cloud_mode(mode),
            None => self.set_error("Choose a cloud mode first.".to_string()),
        }
    }

    /// Save `[cloud] mode` (first, so the choice survives whatever the tunnel does) and
    /// apply it to the background serve when one is up.
    pub(crate) fn save_and_apply_cloud_mode(&mut self, mode: CloudMode) {
        if let Err(err) = self.engine.set_cloud_mode(mode.as_str()) {
            self.set_error(format!("{err:#}"));
            return;
        }
        if self.background_server_is_serving() {
            self.ask_companion_for_cloud_mode(mode);
            return;
        }
        self.set_info(CloudModeOutcome::NotServing.report(mode).message);
    }

    /// Ask the background serve to apply `mode`; the answer arrives as
    /// `WorkerEvent::CloudModeApplied`.
    pub(crate) fn ask_companion_for_cloud_mode(&mut self, mode: CloudMode) {
        if let Some(previous) = self.pending_cloud_mode_op.take() {
            self.apply_reaction(
                previous
                    .resolve(&CloudModeOutcome::TimedOut)
                    .into_reaction(),
            );
        }
        let op = yaran_core::engine::status_op(format!(
            "Applying [cloud] mode = \"{}\" to the running serve…",
            mode.as_str()
        ))
        .resolve_in_handler(move |outcome: &CloudModeOutcome| final_for(outcome.report(mode)));
        let pending = self.engine.begin_status_op(&op);
        self.apply_reaction(yaran_core::engine::EventReaction::Status(pending));
        self.pending_cloud_mode_op = Some(op);
        if let Some(companion) = self.companion.as_mut() {
            companion.set_cloud_mode(&self.engine, mode);
        }
    }

    /// Resolve the pending op with what the serve did, or say it on the shared lane when
    /// nothing on this surface is waiting.
    pub(crate) fn apply_cloud_mode_outcome(&mut self, mode: CloudMode, outcome: CloudModeOutcome) {
        match self.pending_cloud_mode_op.take() {
            Some(op) => self.apply_reaction(op.resolve(&outcome).into_reaction()),
            None => self.engine.post_status(outcome.status(mode)),
        }
    }

    /// The background-mode reload owner: a changed mode goes through the companion (only
    /// when a serve ran both before and after the reload, so it is never applied twice),
    /// a changed restart key restarts the running child.
    pub(crate) fn apply_cloud_reload(
        &mut self,
        serving_before: bool,
        previous: &CloudLegSettings,
        next: &CloudLegSettings,
    ) {
        if !(serving_before && self.background_server_is_serving()) {
            return;
        }
        if previous.restart_keys_differ(next)
            && let Some(companion) = self.companion.as_mut()
        {
            companion.cloud_settings_changed(next.clone());
        }
        if previous.mode != next.mode {
            self.ask_companion_for_cloud_mode(next.mode);
        }
    }

    pub(crate) fn handle_set_cloud_mode_prompt_key(&mut self, key: KeyEvent) -> Option<bool> {
        let PromptState::SetCloudMode(prompt) = &mut self.prompt else {
            return None;
        };
        let palette_action = self.bindings.lookup(&key, BindingScope::Palette);
        let dialog_action = self.bindings.lookup(&key, BindingScope::Dialog);
        match palette_action.or(dialog_action) {
            Some(Action::CloseOverlay) => {
                self.prompt = PromptState::None;
                self.clear_prompt_hint();
                self.set_info(
                    "Left the cloud mode as it was; config.toml is untouched.".to_string(),
                );
            }
            Some(Action::MoveDown) if prompt.selected + 1 < prompt.options.len() => {
                prompt.selected += 1;
            }
            Some(Action::MoveUp) if prompt.selected > 0 => prompt.selected -= 1,
            Some(Action::Confirm) => self.apply_set_cloud_mode(),
            _ => {}
        }
        Some(false)
    }

    pub(crate) fn click_cloud_mode_item(&mut self, index: usize, double_click: bool) {
        if let PromptState::SetCloudMode(prompt) = &mut self.prompt
            && index < prompt.options.len()
        {
            prompt.selected = index;
        }
        if double_click {
            self.apply_set_cloud_mode();
        }
    }

    pub(crate) fn render_set_cloud_mode_prompt(&mut self, frame: &mut Frame) {
        let PromptState::SetCloudMode(prompt) = &self.prompt else {
            return;
        };
        self.render_dim_overlay(frame);
        let area = centered_rect(66, 55, frame.area());
        self.clear_overlay_area(frame, area);
        let hint = |text: String, key: bool| {
            let fg = if key {
                self.theme.hint_key_fg
            } else {
                self.theme.hint_desc_fg
            };
            Span::styled(text, Style::default().fg(fg))
        };
        let picks = if prompt.serving {
            "apply now"
        } else {
            "save for next time"
        };
        let bottom_spans = vec![
            hint(
                format!(
                    " {}/{} ",
                    self.bindings.label_for(Action::MoveUp),
                    self.bindings.label_for(Action::MoveDown)
                ),
                true,
            ),
            hint("move  ".into(), false),
            hint(
                format!("{} ", self.bindings.label_for(Action::Confirm)),
                true,
            ),
            hint(picks.into(), false),
            hint(
                format!("  {} ", self.bindings.label_for(Action::CloseOverlay)),
                true,
            ),
            hint("cancel ".into(), false),
        ];
        let [details_area, list_area] = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(4), Constraint::Min(5)])
            .areas(area);
        let where_at = if prompt.serving {
            "A serve is running, so the choice applies to it right away."
        } else {
            "Nothing is serving, so the choice applies when a listener starts."
        };
        let details = Paragraph::new(vec![
            Line::from(vec![
                hint(" Saved mode: ".into(), false),
                Span::styled(
                    prompt.current.as_str().to_string(),
                    Style::default()
                        .fg(self.theme.text_fg)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            Line::from(vec![hint(format!(" {where_at}"), false)]),
        ])
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(self.theme.overlay_border))
                .style(Style::default().bg(self.theme.overlay_bg))
                .title(" Remote access (Cloudflare tunnel) ")
                .title_style(
                    Style::default()
                        .fg(self.theme.title_focused)
                        .add_modifier(Modifier::BOLD),
                ),
        );
        frame.render_widget(details, details_area);
        let items: Vec<_> = prompt
            .options
            .iter()
            .map(|option| {
                ListItem::new(Line::from(vec![
                    active_provider_marker_span(option.is_current, &self.theme),
                    Span::styled(
                        format!("{:<6}", option.mode.as_str()),
                        Style::default()
                            .fg(self.theme.help_section_header_fg)
                            .add_modifier(Modifier::BOLD),
                    ),
                    hint(format!("  {}", meaning(option.mode)), false),
                ]))
            })
            .collect();
        let mut state = ListState::default().with_selected(Some(
            prompt.selected.min(prompt.options.len().saturating_sub(1)),
        ));
        let list_block = Block::default()
            .borders(Borders::LEFT | Borders::RIGHT | Borders::BOTTOM)
            .border_style(Style::default().fg(self.theme.overlay_border))
            .style(Style::default().bg(self.theme.overlay_bg))
            .title_bottom(Line::from(bottom_spans));
        let list_inner = list_block.inner(list_area);
        let items_len = prompt.options.len();
        StatefulWidget::render(
            List::new(items)
                .block(list_block)
                .highlight_style(self.theme.selection_style()),
            list_area,
            frame.buffer_mut(),
            &mut state,
        );
        self.overlay_layout.active = OverlayMouseLayout::SetCloudMode {
            list: list_inner,
            items: items_len,
            offset: state.offset(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_picker_marks_the_saved_mode_and_cancel_saves_nothing() {
        let mut app =
            crate::app::test_support::test_app(crate::app::test_support::default_bindings());
        app.open_set_cloud_mode_prompt();
        let PromptState::SetCloudMode(prompt) = &app.prompt else {
            panic!("the picker is open");
        };
        assert_eq!(prompt.options.len(), 3);
        assert!(prompt.options[prompt.selected].is_current);
        assert!(!prompt.serving);
        assert_eq!(
            crate::app::modal::modal_spec(&app.prompt).map(|spec| spec.family),
            Some(crate::app::modal::ModalFamily::Picker)
        );
    }

    #[test]
    fn picking_the_saved_mode_with_nothing_serving_says_so() {
        let mut app =
            crate::app::test_support::test_app(crate::app::test_support::default_bindings());
        app.open_set_cloud_mode_prompt();
        app.apply_set_cloud_mode();
        assert!(matches!(app.prompt, PromptState::None));
        assert!(app.pending_cloud_mode_op.is_none());
    }

    #[test]
    fn an_outcome_with_no_pending_op_is_posted_and_one_with_an_op_resolves_it() {
        let mut app =
            crate::app::test_support::test_app(crate::app::test_support::default_bindings());
        app.apply_cloud_mode_outcome(CloudMode::Auto, CloudModeOutcome::NotPaired);
        assert!(app.pending_cloud_mode_op.is_none());
        app.ask_companion_for_cloud_mode(CloudMode::No);
        assert!(app.pending_cloud_mode_op.is_some());
        app.apply_cloud_mode_outcome(CloudMode::No, CloudModeOutcome::Stopped);
        assert!(app.pending_cloud_mode_op.is_none());
    }
}
