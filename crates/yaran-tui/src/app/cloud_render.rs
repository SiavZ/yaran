//! Drawing the Yaran Cloud modals: the login form, the two confirms, the status report
//! and the phone QR.
//!
//! Every name a body shows (an org, a hostname, the approval page, the fingerprint, a
//! command) is a name chip, and every color comes from the theme. The QR is painted
//! from the module matrix with the `qr_dark` / `qr_light` tokens, two modules per cell
//! row through the upper-half block, so it stays square and scannable.
//!
//! - One frame helper sizes each modal to its wrapped body plus a fixed tail.
//! - The login's field goes through the shared single-line renderer and publishes its
//!   rect so a click can land the caret.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_render.rs
//! ├── app
//! ├── app::cloud_commands
//! ├── app::components
//! ├── app::components::button
//! ├── app::modal
//! ├── app::render
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::status
//! └── yaran-core::prose
//! External: none
//!
//! Used by:
//! app/cloud_render.rs
//! ├── app
//! └── app::cloud_tests
//! <module-headers:end>

use yaran_core::cloud::outcome::CloudActionOutcome;
use yaran_core::cloud::status::StatusReport;
use yaran_core::prose::Prose;

use super::cloud_commands::{CloudLogin, CloudPrompt, PhoneQr};
use super::components::button::ButtonState;
use super::components::{
    Button, ButtonKind, Hint, modal_hint_line, prose_lines, shared_button_width, wrap_styled_lines,
};
use super::modal::ModalFrame;
use super::render::{centered_rect_exact, render_single_line_cursor_input};
use super::*;

/// Blank columns between the border and the content, each side.
const PAD: u16 = 2;
/// Columns between the two confirm buttons: enough that a sloppy click cannot hit both.
const BUTTON_GAP: u16 = 4;

const LOGOUT_BODY: &str = "Disconnect this machine from Yaran Cloud? The control plane is told \
     to remove it and the credentials stored here are deleted. Pairing it again needs a new \
     browser login.";
const ROTATE_BODY: &str = "Rotate this machine's tunnel token? The control plane issues a new \
     token and the old one stops working; a running yaran reconnects with the new one by itself.";

/// The QR as rows of upper-half blocks: each cell's foreground is the module above,
/// its background the module below, both from the theme's two QR tokens only.
pub(crate) fn qr_lines(
    size: usize,
    is_dark: impl Fn(usize, usize) -> bool,
    theme: &Theme,
) -> Vec<Line<'static>> {
    let color = |dark: bool| if dark { theme.qr_dark } else { theme.qr_light };
    (0..size.div_ceil(2))
        .map(|row| {
            let top = 2 * row;
            Line::from(
                (0..size)
                    .map(|x| {
                        let below = top + 1 < size && is_dark(x, top + 1);
                        Span::styled(
                            "\u{2580}",
                            Style::default().fg(color(is_dark(x, top))).bg(color(below)),
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

impl App {
    pub(super) fn render_cloud_prompt(&mut self, frame: &mut Frame) {
        let PromptState::Cloud(prompt) = &self.prompt else {
            return;
        };
        let prompt = prompt.clone();
        let (mut field, mut cancel, mut confirm) = (None, None, None);
        match &prompt {
            CloudPrompt::Login(login) => field = Some(self.render_cloud_login(frame, login)),
            CloudPrompt::Logout(focus) | CloudPrompt::Rotate(focus) => {
                let (title, body, act, kind) = if matches!(prompt, CloudPrompt::Logout(_)) {
                    (
                        "Disconnect From Yaran Cloud",
                        LOGOUT_BODY,
                        "Disconnect",
                        ButtonKind::Danger,
                    )
                } else {
                    (
                        "Rotate Tunnel Token",
                        ROTATE_BODY,
                        "Rotate token",
                        ButtonKind::Confirm,
                    )
                };
                let (c, k) = self.render_cloud_confirm(frame, title, body, act, kind, *focus);
                (cancel, confirm) = (Some(c), Some(k));
            }
            CloudPrompt::Status(report) => {
                let body = self.cloud_status_lines(report.as_deref());
                self.render_cloud_report(frame, "Yaran Cloud Status", 76, &body);
            }
            CloudPrompt::PairPhone(qr) => {
                let (width, body) = self.cloud_pair_phone_lines(qr.as_ref());
                self.render_cloud_report(frame, "Connect a Phone", width, &body);
            }
        }
        self.overlay_layout.active = OverlayMouseLayout::Cloud {
            field,
            cancel,
            confirm,
        };
    }

    fn cloud_text(&self) -> Style {
        Style::default().fg(self.theme.text_fg)
    }

    fn cloud_prose(&self, prose: &Prose) -> Vec<Line<'static>> {
        prose_lines(prose, "", self.cloud_text(), &self.theme)
    }

    /// Open a modal `width` wide holding `body` wrapped to its content width and
    /// `tail` rows under it. Returns the rect of that tail.
    fn cloud_frame(
        &mut self,
        frame: &mut Frame,
        title: &str,
        width: u16,
        body: &[Line<'static>],
        tail: u16,
    ) -> Rect {
        let screen = frame.area();
        let width = width.min(screen.width.max(1));
        let content_width = width.saturating_sub(2 + 2 * PAD).max(1);
        let rows = wrap_styled_lines(body, usize::from(content_width));
        let body_height = u16::try_from(rows.len()).unwrap_or(u16::MAX);
        // shortcut: a body taller than the screen is clipped, not scrolled; the
        // tallest (the QR) fits a 40-row terminal. Add scrolling if that bites.
        let area = centered_rect_exact(width, 3 + body_height + tail, screen);
        let ModalFrame { inner, .. } = self.open_modal_frame(frame, title, area);
        let content = Rect::new(
            inner.x + PAD,
            inner.y + 1,
            content_width.min(inner.width),
            inner.height.saturating_sub(1),
        );
        let body_area = Rect {
            height: body_height.min(content.height),
            ..content
        };
        Paragraph::new(rows).render(body_area, frame.buffer_mut());
        Rect::new(
            content.x,
            body_area.bottom(),
            content.width,
            tail.min(content.bottom().saturating_sub(body_area.bottom())),
        )
    }

    fn render_cloud_hints(&self, frame: &mut Frame, x: u16, y: u16, width: u16, hints: &[Hint]) {
        let mut line = modal_hint_line(&self.theme, hints);
        if let Some(first) = line.spans.first_mut() {
            first.content = first.content.trim_start().to_string().into();
        }
        if y < frame.area().bottom() {
            Paragraph::new(line).render(Rect::new(x, y, width, 1), frame.buffer_mut());
        }
    }

    /// The login form. Returns the field's inner rect for the mouse.
    fn render_cloud_login(&mut self, frame: &mut Frame, login: &CloudLogin) -> Rect {
        let text = self.cloud_text();
        let label = Style::default().fg(self.theme.input_label_fg);
        let mut body: Vec<Line<'static>> = Vec::new();
        let field_label = match &login.waiting {
            None => {
                body.push(Line::from(Span::styled(
                    "Pair this machine with a Yaran Cloud organization. Type its address; \
                     yaran then opens your browser so you can approve this machine there.",
                    text,
                )));
                "Organization address:"
            }
            Some(waiting) => {
                let lead = match &waiting.authorize {
                    None => Prose::new()
                        .text("Contacting ")
                        .name(&waiting.org_url)
                        .text("..."),
                    Some(info) => Prose::new()
                        .text("Approve ")
                        .name(&info.machine_name)
                        .text(" for ")
                        .name(&info.org_name)
                        .text(" in your browser, but only if the page shows this fingerprint: ")
                        .name(&info.fingerprint),
                };
                body.extend(self.cloud_prose(&lead));
                if let Some(info) = &waiting.authorize {
                    body.push(Line::from(""));
                    body.extend(
                        self.cloud_prose(&Prose::new().text("Approval page: ").name(&info.url)),
                    );
                }
                if let Some(note) = &waiting.note {
                    body.push(Line::from(""));
                    body.push(Line::from(Span::styled(
                        note.clone(),
                        Style::default().fg(self.theme.warning_fg),
                    )));
                }
                "Browser on another device? Paste the address it landed on:"
            }
        };
        body.push(Line::from(""));
        body.push(Line::from(Span::styled(field_label, label)));
        let rest = self.cloud_frame(frame, "Yaran Cloud Login", 76, &body, 5);

        // The field is the modal's only control, so it always has focus.
        let field_area = Rect::new(rest.x, rest.y, rest.width, 3.min(rest.height));
        let block = Block::default()
            .borders(Borders::ALL)
            .border_set(border::ROUNDED)
            .border_style(self.theme.overlay_field_border_style(true));
        let inner = block.inner(field_area);
        let input = login.field();
        Paragraph::new(render_single_line_cursor_input(
            " ",
            &input.text,
            input.cursor,
            self.theme.input_cursor_fg,
            self.theme.input_cursor_bg,
            true,
        ))
        .block(block)
        .render(field_area, frame.buffer_mut());

        let submit = if login.waiting.is_some() {
            "submit address"
        } else {
            "start login"
        };
        let close = if login.waiting.is_some() {
            "cancel login"
        } else {
            "cancel"
        };
        self.render_cloud_hints(
            frame,
            rest.x,
            rest.y + 4,
            rest.width,
            &[
                Hint::key(self.bindings.label_for(Action::Confirm), submit),
                Hint::key(self.bindings.label_for(Action::CloseOverlay), close),
            ],
        );
        inner
    }

    /// A Cancel / act pair under one sentence. Returns (cancel, act) rects.
    fn render_cloud_confirm(
        &mut self,
        frame: &mut Frame,
        title: &str,
        body: &'static str,
        act: &'static str,
        kind: ButtonKind,
        focus: ConfirmFocus,
    ) -> (Rect, Rect) {
        let lines = vec![Line::from(Span::styled(body, self.cloud_text()))];
        let rest = self.cloud_frame(frame, title, 64, &lines, 6);
        let width = shared_button_width(&["Cancel", act]);
        let left = rest.x + rest.width.saturating_sub(2 * width + BUTTON_GAP) / 2;
        let cancel = Rect::new(left, rest.y + 1, width, 3);
        let confirm = Rect::new(left + width + BUTTON_GAP, rest.y + 1, width, 3);
        let state = |focused: bool| {
            if focused {
                ButtonState::Focused
            } else {
                ButtonState::Normal
            }
        };
        Button::new("Cancel")
            .kind(ButtonKind::Confirm)
            .state(state(!focus.is_confirm()))
            .render(frame, cancel, &self.theme);
        Button::new(act)
            .kind(kind)
            .state(state(focus.is_confirm()))
            .render(frame, confirm, &self.theme);
        self.render_cloud_hints(
            frame,
            rest.x,
            rest.y + 5,
            rest.width,
            &[
                Hint::key(self.bindings.label_for(Action::ToggleSelection), "focus"),
                Hint::key(self.bindings.label_for(Action::Confirm), "press"),
                Hint::key(self.bindings.label_for(Action::CloseOverlay), "cancel"),
            ],
        );
        (cancel, confirm)
    }

    fn render_cloud_report(
        &mut self,
        frame: &mut Frame,
        title: &str,
        width: u16,
        body: &[Line<'static>],
    ) {
        let rest = self.cloud_frame(frame, title, width, body, 2);
        self.render_cloud_hints(
            frame,
            rest.x,
            rest.y + 1,
            rest.width,
            &[
                Hint::key(self.bindings.label_for(Action::Confirm), "close"),
                Hint::key(self.bindings.label_for(Action::CloseOverlay), "close"),
            ],
        );
    }

    /// The status report's body: the outcome sentence when there is one to say,
    /// then the pairing, one labelled row per fact, names as chips.
    pub(crate) fn cloud_status_lines(&self, report: Option<&StatusReport>) -> Vec<Line<'static>> {
        let Some(r) = report else {
            return vec![Line::from(Span::styled(
                "Checking the pairing and asking the control plane...",
                self.cloud_text(),
            ))];
        };
        if let Some(reason) = &r.error {
            return self.cloud_prose(&Prose::from(reason.as_str()));
        }
        let mut lines = Vec::new();
        let label = Style::default().fg(self.theme.hint_desc_fg);
        // A chip's own pad takes the first cell, so chipped values start one column
        // left of plain ones and their text lines up.
        let chip_row = |name: &str, value: &Option<String>, lines: &mut Vec<Line<'static>>| {
            if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                lines.push(Line::from(vec![
                    Span::styled(format!("{name:<14}"), label),
                    super::components::name_chip(value, &self.theme),
                ]));
            }
        };
        let text_row = |name: &str, value: String, lines: &mut Vec<Line<'static>>| {
            lines.push(Line::from(vec![
                Span::styled(format!("{name:<15}"), label),
                Span::styled(value, self.cloud_text()),
            ]));
        };
        if !r.paired {
            lines.extend(self.cloud_prose(&status_prose(&CloudActionOutcome::NotPaired)));
            lines.push(Line::from(""));
            text_row("Mode", r.mode.clone(), &mut lines);
            return lines;
        }
        if r.is_revoked() {
            let revoked = CloudActionOutcome::Revoked {
                hostname: r.hostname.clone().unwrap_or_default(),
            };
            lines.extend(self.cloud_prose(&status_prose(&revoked)));
            lines.push(Line::from(""));
        }
        chip_row("Organization", &r.org_name, &mut lines);
        chip_row("Address", &r.org_url, &mut lines);
        chip_row("Hostname", &r.hostname, &mut lines);
        chip_row("Machine id", &r.machine_id, &mut lines);
        chip_row("Owner", &r.owner_email, &mut lines);
        let number = |n: Option<String>| n.unwrap_or_else(|| "unknown".into());
        text_row(
            "Origin port",
            number(r.origin_port.map(|p| p.to_string())),
            &mut lines,
        );
        text_row(
            "Token version",
            number(r.token_version.map(|v| v.to_string())),
            &mut lines,
        );
        text_row("Paired at", number(r.paired_at.clone()), &mut lines);
        if let Some(at) = &r.revoked_at {
            text_row("Revoked at", at.clone(), &mut lines);
        }
        text_row("Mode", r.mode.clone(), &mut lines);
        let tunnel = match &r.leg {
            Some(leg) => format!("{} (pid {}, since {})", leg.state, leg.pid, leg.since),
            None => "not running (no yaran is serving remote access)".into(),
        };
        text_row("Tunnel", tunnel, &mut lines);
        let remote = match &r.remote {
            None => "not checked".to_string(),
            Some(x) if x.revoked => "this machine was revoked".into(),
            Some(x) if x.reachable => match (x.token_version, r.token_version) {
                (Some(remote), Some(local)) if remote > local => format!(
                    "reachable; a newer tunnel token (version {remote}) exists, and a running \
                     yaran fetches it"
                ),
                _ => "reachable".into(),
            },
            Some(x) => format!("unreachable: {}", x.detail.clone().unwrap_or_default()),
        };
        text_row("Control plane", remote, &mut lines);
        lines
    }

    /// The phone dialog's width and body: the QR, then where it points.
    fn cloud_pair_phone_lines(
        &self,
        qr: Option<&Result<PhoneQr, Prose>>,
    ) -> (u16, Vec<Line<'static>>) {
        let text = self.cloud_text();
        let qr = match qr {
            None => {
                let wait = Line::from(Span::styled("Preparing the code...", text));
                return (64, vec![wait]);
            }
            Some(Err(reason)) => return (64, self.cloud_prose(reason)),
            Some(Ok(qr)) => qr,
        };
        let size = qr.modules.len();
        let width = u16::try_from(size).unwrap_or(u16::MAX).max(60) + 2 + 2 * PAD;
        let indent = (usize::from(width - 2 - 2 * PAD) - size) / 2;
        let mut lines: Vec<Line<'static>> = qr_lines(size, |x, y| qr.modules[y][x], &self.theme)
            .into_iter()
            .map(|row| {
                let mut spans = vec![Span::raw(" ".repeat(indent))];
                spans.extend(row.spans);
                Line::from(spans)
            })
            .collect();
        lines.push(Line::from(""));
        lines.extend(
            self.cloud_prose(
                &Prose::new()
                    .text("Scan this with the Yaran app on your phone to add ")
                    .name(&qr.org_url)
                    .text("."),
            ),
        );
        // The link is a row of its own, which is only a name, so it is plain text:
        // no row is wide enough to keep it whole as a chip.
        lines.push(Line::from(Span::styled(
            "Or open this link on the phone:",
            text,
        )));
        lines.push(Line::from(Span::styled(qr.uri.clone(), text)));
        lines.push(Line::from(Span::styled(
            "No app yet? Install Yaran from your app store first, then scan again.",
            text,
        )));
        (width, lines)
    }
}

/// An outcome's sentence with its names, for a modal body.
pub(crate) fn status_prose(outcome: &CloudActionOutcome) -> Prose {
    let report = outcome.report();
    report
        .prose()
        .cloned()
        .unwrap_or_else(|| Prose::from(report.message()))
}
