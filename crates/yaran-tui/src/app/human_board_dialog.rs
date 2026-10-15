//! The human board's card dialog and its Assign picker: how they are laid out
//! and drawn, and the text selection the dialog's body supports.
//!
//! Layout rules, all of them about not moving things under the reader:
//!
//! - Every element (the card's text, the reply label, the reply field, the
//!   buttons and the key line) starts and ends at the same two columns, the
//!   dialog's padded content edges.
//! - The reply field grows downward as the reply wraps, up to
//!   [`REPLY_MAX_ROWS`] rows, and scrolls after that. The dialog is placed as if
//!   the field were already at its tallest, so its top edge never moves while
//!   someone types; it only grows at the bottom.
//! - The buttons share the row in equal widths that depend only on which
//!   buttons the card has, never on their labels, so "Mark done" turning into
//!   "Send & mark done" moves nothing.
//!
//! A drag over the card's text selects it, and the selection is copied to the
//! clipboard when the button is released, as the startup-log viewer does.

use super::components::wrap_lines::display_width;
use super::components::{
    Button, ButtonKind, ButtonPressedTarget, Hint, button_state_for, modal_hint_line,
    render_scroll_marker, soft_name_chip, wrap_styled_lines,
};
use super::human_board::{HumanBoardCardFocus as Focus, Recipient};
use super::render::{age_words, centered_rect_exact};
use super::*;

/// The most rows the reply field grows to before it scrolls.
pub(crate) const REPLY_MAX_ROWS: u16 = 5;
/// The dialog's width when the terminal is wide enough.
const DIALOG_WIDTH: u16 = 92;
/// Blank columns between the dialog's border and its content, each side.
const PAD: u16 = 2;
/// Columns plain text sits inside the content edge, each side. A box's border
/// is drawn down the middle of its cell, so text one column in starts right
/// where the boxes' lines begin.
const TEXT_INSET: u16 = 1;
/// Columns between two buttons.
const BUTTON_GAP: u16 = 2;
/// Cells between the reply field's border and its text, each side.
const FIELD_PAD: u16 = 1;

/// What the open card dialog's body shows, kept from the last frame for the
/// mouse: where the body is, how far it is scrolled, and its text row by row.
#[derive(Clone, Debug, Default)]
pub(crate) struct CardView {
    pub(crate) body: Rect,
    pub(crate) scroll: u16,
    /// Every wrapped row of the body, as plain text.
    pub(crate) rows: Vec<String>,
    /// For each row: whether it continues the line above (a soft wrap), so a
    /// copy joins it with a space rather than a line break.
    pub(crate) continues: Vec<bool>,
    pub(crate) selection: Option<TerminalSelection>,
}

/// The rows of the reply field's text to show and where the caret is among
/// them: `(rows, first, caret_row, caret_col)`, `first` being the index of the
/// first row shown. `scroll` is where the wheel left the field; without it the
/// caret's row stays in view (the end of the reply while typing).
pub(crate) fn reply_window(
    input: &super::text_input::TextInput,
    text_width: usize,
    scroll: Option<usize>,
) -> (Vec<String>, usize, usize, usize) {
    let (rows, caret_row, caret_col) = input.wrapped_rows(text_width);
    let visible = rows.len().clamp(1, REPLY_MAX_ROWS as usize);
    let last_first = rows.len().saturating_sub(visible);
    let first = scroll
        .unwrap_or_else(|| (caret_row + 1).saturating_sub(visible))
        .min(last_first);
    (rows, first, caret_row, caret_col)
}

/// The reply field's text width inside a field box `width` columns wide.
pub(crate) fn reply_text_width(width: u16) -> usize {
    usize::from(width.saturating_sub(2 + 2 * FIELD_PAD)).max(1)
}

impl App {
    /// The card dialog's buttons for its current state, in drawing and focus
    /// order: Close, Send (with a reply field), the action, Assign (on an
    /// assignable card).
    fn card_dialog_buttons(
        &self,
        card: &yaran_core::human_board::Card,
        reply: Option<&super::human_board::CardReply>,
        forwardable: bool,
    ) -> Vec<(ButtonPressedTarget, &'static str, Focus)> {
        let has_text = reply.is_some_and(|reply| !reply.input.text.trim().is_empty());
        let mut row = vec![(
            ButtonPressedTarget::HumanBoardCardClose,
            "Close",
            Focus::Close,
        )];
        if let Some(reply) = reply {
            let send =
                if !has_text && forwardable && matches!(reply.recipient(), Recipient::Agent(_)) {
                    "Forward"
                } else {
                    "Send"
                };
            row.push((ButtonPressedTarget::HumanBoardCardSend, send, Focus::Send));
        }
        let action = match (card.is_open(), has_text) {
            (true, true) => "Send & mark done",
            (true, false) => "Mark done",
            (false, _) => "Reopen",
        };
        row.push((
            ButtonPressedTarget::HumanBoardCardAction,
            action,
            Focus::Action,
        ));
        if self.board_card_assignable(card) {
            row.push((
                ButtonPressedTarget::HumanBoardCardAssign,
                "Assign\u{2026}",
                Focus::Assign,
            ));
        }
        row
    }

    /// One card of the human board, whole: what it asks, who posted it and
    /// when, its detail and conversation, a reply field, and its actions.
    pub(super) fn render_human_board_card_prompt(&mut self, frame: &mut Frame) {
        let PromptState::HumanBoardCard {
            card,
            focus,
            scroll,
            reply,
        } = &self.prompt
        else {
            return;
        };
        let card = (**card).clone();
        let focus = *focus;
        let scroll = *scroll;
        let reply = reply.as_ref().map(|reply| (**reply).clone());
        let forwardable = !self.forwardable_messages(&card).is_empty();
        let buttons = self.card_dialog_buttons(&card, reply.as_ref(), forwardable);
        self.render_dim_overlay(frame);

        let screen = frame.area();
        let width = DIALOG_WIDTH.min(screen.width.max(1));
        let content_width = width.saturating_sub(2 + 2 * PAD).max(1);
        let text_width = content_width.saturating_sub(2 * TEXT_INSET).max(1);
        let text = Style::default().fg(self.theme.text_fg);
        let label = Style::default().fg(self.theme.hint_desc_fg);
        let now = chrono::Utc::now();

        // ── The card's text, as logical lines ──────────────────────────────
        let mut lines: Vec<Line<'static>> = vec![Line::from(Span::styled(
            card.title.clone(),
            text.add_modifier(Modifier::BOLD),
        ))];
        lines.push(Line::from(""));
        let field = |name: &'static str, value: Span<'static>| {
            Line::from(vec![Span::styled(format!("{name:<10}"), label), value])
        };
        lines.push(field(
            "Kind:",
            Span::styled(card.kind.heading().to_string(), text),
        ));
        lines.push(field(
            "Priority:",
            Span::styled(
                card.priority.label().to_string(),
                if card.priority.is_urgent() {
                    Style::default().fg(self.theme.warning_fg)
                } else {
                    text
                },
            ),
        ));
        if card.blocking && card.is_open() {
            lines.push(field(
                "Blocking:",
                Span::styled(
                    "the agent that posted it waits for an answer".to_string(),
                    Style::default().fg(self.theme.diff_remove),
                ),
            ));
        }
        // A chip's own padding takes the first cell, so chipped values start one
        // column left of plain ones and their text lines up with them.
        let chip_field = |name: &'static str, value: &str| {
            Line::from(vec![
                Span::styled(format!("{name:<9}"), label),
                soft_name_chip(value, &self.theme),
            ])
        };
        if let Some(ticket) = &card.ticket {
            lines.push(chip_field("Ticket:", ticket));
        }
        if let Some(assignee) = &card.assignee {
            lines.push(chip_field("For:", assignee));
        }
        if let Some(from) = &card.from {
            lines.push(chip_field("From:", from));
        }
        let posted = yaran_core::human_board::compact_age(card.created_at, now);
        let mut when = format!("posted {}", age_words(&posted));
        if card.updated_at > card.created_at {
            let updated = yaran_core::human_board::compact_age(card.updated_at, now);
            when.push_str(&format!(", updated {}", age_words(&updated)));
        }
        lines.push(field("When:", Span::styled(when, text)));
        lines.push(field("Card:", Span::styled(format!("#{}", card.id), text)));
        if let Some(resolved_at) = card.resolved_at {
            let ago = yaran_core::human_board::compact_age(resolved_at, now);
            let by = card
                .resolved_by
                .as_deref()
                .map(|by| format!(" by {by}"))
                .unwrap_or_default();
            lines.push(field(
                "Done:",
                Span::styled(format!("{}{by}", age_words(&ago)), text),
            ));
        }
        if let Some(detail) = &card.detail {
            lines.push(Line::from(""));
            for line in detail.lines() {
                lines.push(Line::from(Span::styled(line.to_string(), text)));
            }
        }
        // The conversation: each message's text indented under its writer.
        let mut indented: Vec<(usize, String)> = Vec::new();
        if !card.thread.is_empty() {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                "Conversation",
                label.add_modifier(Modifier::BOLD),
            )));
            for message in &card.thread {
                let ago = yaran_core::human_board::compact_age(message.at, now);
                let mut about = format!(" \u{b7} {}", age_words(&ago));
                if message.done {
                    about.push_str(" \u{b7} marked done");
                }
                if message.relayed_at.is_some() {
                    about.push_str(" \u{b7} passed on");
                }
                lines.push(Line::from(""));
                lines.push(Line::from(vec![
                    Span::styled(message.from.clone(), text.add_modifier(Modifier::BOLD)),
                    Span::styled(about, label),
                ]));
                for line in message.text.lines() {
                    indented.push((lines.len(), line.to_string()));
                    lines.push(Line::from(Span::styled(line.to_string(), text)));
                }
            }
        }

        // ── Wrap every logical line, remembering where wraps fell ──────────
        let mut wrapped: Vec<Line<'static>> = Vec::new();
        let mut continues: Vec<bool> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            let indent = indented.iter().any(|(at, _)| *at == index);
            let rows = if indent {
                wrap_styled_lines(
                    std::slice::from_ref(line),
                    usize::from(text_width.saturating_sub(2)).max(1),
                )
                .into_iter()
                .map(|row| {
                    let mut spans = vec![Span::raw("  ")];
                    spans.extend(row.spans);
                    Line::from(spans)
                })
                .collect::<Vec<_>>()
            } else {
                wrap_styled_lines(std::slice::from_ref(line), usize::from(text_width))
            };
            let rows = if rows.is_empty() {
                vec![Line::from("")]
            } else {
                rows
            };
            for (n, row) in rows.into_iter().enumerate() {
                continues.push(n > 0);
                wrapped.push(row);
            }
        }
        let plain: Vec<String> = wrapped
            .iter()
            .map(|line| {
                line.spans
                    .iter()
                    .map(|span| span.content.as_ref())
                    .collect()
            })
            .collect();
        let total_rows = u16::try_from(wrapped.len()).unwrap_or(u16::MAX);

        // ── The fixed part under the text, at its current and tallest ──────
        let no_target = card.is_open() && reply.is_none();
        let field_box_width = content_width;
        let reply_rows = reply
            .as_ref()
            .map(|reply| {
                let (rows, ..) = reply_window(
                    &reply.input,
                    reply_text_width(field_box_width),
                    reply.scroll,
                );
                rows.len().clamp(1, REPLY_MAX_ROWS as usize) as u16
            })
            .unwrap_or(0);
        let bottom = |field_rows: u16| -> u16 {
            let reply_part = if reply.is_some() {
                1 + 2 + field_rows
            } else if no_target {
                1
            } else {
                0
            };
            let gap_above = 1;
            let gap_before_buttons = if reply_part > 0 { 1 } else { 0 };
            gap_above + reply_part + gap_before_buttons + 3 + 1
        };
        let bottom_now = bottom(reply_rows);
        let bottom_tallest = bottom(if reply.is_some() { REPLY_MAX_ROWS } else { 0 });
        // Two border rows and one blank row above the text.
        let max_body = screen.height.saturating_sub(2 + 1 + bottom_tallest).max(1);
        let body_height = total_rows.clamp(1, max_body);
        let tallest = centered_rect_exact(width, 2 + 1 + body_height + bottom_tallest, screen);
        let area = Rect {
            height: (2 + 1 + body_height + bottom_now)
                .min(screen.height.saturating_sub(tallest.y - screen.y)),
            ..tallest
        };
        self.clear_overlay_area(frame, area);

        let title = match &card.ticket {
            Some(ticket) => format!("Card {} \u{b7} {ticket}", card.id),
            None => format!("Card {}", card.id),
        };
        let scrollable = total_rows > body_height;
        let mut block = self.themed_overlay_block(&title);
        if scrollable {
            let up = self.bindings.labels_for(Action::ScrollPageUp);
            let down = self.bindings.labels_for(Action::ScrollPageDown);
            let mut hint: Vec<Span<'static>> = vec![Span::raw(" ")];
            for span in self.theme.key_badge_default(&up) {
                hint.push(Span::styled(span.content.to_string(), span.style));
            }
            hint.push(Span::styled("/", label));
            for span in self.theme.key_badge_default(&down) {
                hint.push(Span::styled(span.content.to_string(), span.style));
            }
            hint.push(Span::styled(" or the wheel scroll the card ", label));
            block = block.title_bottom(Line::from(hint));
        }
        let inner = block.inner(area);
        block.render(area, frame.buffer_mut());
        let content_x = inner.x + PAD;
        let text_x = content_x + TEXT_INSET;

        // ── The text, scrolled, with the selection over it ────────────────
        let body = Rect::new(text_x, inner.y + 1, text_width, body_height);
        let max_scroll = total_rows.saturating_sub(body.height);
        let scroll = scroll.min(max_scroll);
        Paragraph::new(wrapped)
            .scroll((scroll, 0))
            .render(body, frame.buffer_mut());
        let selection = self.human_board.card_view.selection.clone();
        if let Some(selection) = selection.filter(|s| s.anchor != s.end) {
            let style = self.theme.selection_style();
            for y in 0..body.height {
                for x in 0..body.width {
                    if selection.contains(scroll + y, x) {
                        frame.buffer_mut()[(body.x + x, body.y + y)].set_style(style);
                    }
                }
            }
        }
        render_scroll_marker(
            frame,
            area,
            body,
            scroll as usize,
            body.height as usize,
            total_rows as usize,
            self.theme.hint_key_fg,
        );
        self.last_error_dialog_height = body.height;
        self.last_error_dialog_lines = total_rows;
        let view = &mut self.human_board.card_view;
        view.body = body;
        view.scroll = scroll;
        view.rows = plain;
        view.continues = continues;

        // ── Reply label and field ──────────────────────────────────────────
        let mut y = body.bottom() + 1;
        let mut reply_field = None;
        let mut recipient_chip = None;
        if let Some(reply) = &reply {
            let then = if reply.enter_marks_done() {
                ", then mark done:"
            } else {
                ":"
            };
            let (lead, name, rest): (&str, String, String) = match reply.recipient() {
                Recipient::Agent(target) if reply.from_elsewhere => (
                    "Hand to ",
                    target.label.clone(),
                    " (your selected agent) to work on:".to_string(),
                ),
                Recipient::Agent(target) => (
                    "Reply to ",
                    target.label.clone(),
                    if target.is_poster {
                        format!(" (posted this card){then}")
                    } else {
                        format!(" (selected agent){then}")
                    },
                ),
                Recipient::Person {
                    name,
                    poster: Some(poster),
                } => (
                    "Reply to ",
                    name.clone(),
                    format!(" (their {poster} posted this card):"),
                ),
                Recipient::Person { name, poster: None } => {
                    ("Ask ", name.clone(), " on this card:".to_string())
                }
            };
            let chip_focused = focus == Focus::Recipient;
            let mut chip = soft_name_chip(&name, &self.theme);
            if chip_focused {
                chip.style = chip
                    .style
                    .add_modifier(Modifier::UNDERLINED | Modifier::BOLD);
            }
            let chip_x = text_x + display_width(lead) as u16;
            let chip_width = display_width(&chip.content) as u16;
            let mut spans = vec![Span::styled(lead, label), chip];
            if reply.recipients.len() > 1 {
                spans.push(Span::styled(
                    " \u{21c4}",
                    if chip_focused {
                        self.theme.title_style(true)
                    } else {
                        label
                    },
                ));
                recipient_chip = Some(Rect::new(chip_x, y, chip_width + 2, 1));
            }
            spans.push(Span::styled(rest, label));
            Paragraph::new(Line::from(spans))
                .render(Rect::new(text_x, y, text_width, 1), frame.buffer_mut());
            y += 1;

            let field_focused = focus == Focus::Reply;
            let field_area = Rect::new(content_x, y, field_box_width, 2 + reply_rows);
            Block::default()
                .borders(Borders::ALL)
                .border_set(border::ROUNDED)
                .border_style(self.theme.overlay_field_border_style(field_focused))
                .render(field_area, frame.buffer_mut());
            let field_text_width = reply_text_width(field_box_width);
            let (rows, first, caret_row, caret_col) =
                reply_window(&reply.input, field_text_width, reply.scroll);
            let field_text_x = field_area.x + 1 + FIELD_PAD;
            for (offset, row) in rows
                .iter()
                .skip(first)
                .take(reply_rows as usize)
                .enumerate()
            {
                frame.buffer_mut().set_string(
                    field_text_x,
                    field_area.y + 1 + offset as u16,
                    row,
                    text,
                );
            }
            // More reply than the field shows: the marker in its right border
            // says where the window is, as the card's own marker does.
            render_scroll_marker(
                frame,
                field_area,
                Rect::new(
                    field_text_x,
                    field_area.y + 1,
                    field_text_width as u16,
                    reply_rows,
                ),
                first,
                reply_rows as usize,
                rows.len(),
                self.theme.hint_key_fg,
            );
            if field_focused && caret_row >= first && caret_row < first + reply_rows as usize {
                let cx = field_text_x + caret_col.min(field_text_width.saturating_sub(1)) as u16;
                let cy = field_area.y + 1 + (caret_row - first) as u16;
                frame.buffer_mut()[(cx, cy)].set_style(
                    Style::default()
                        .fg(self.theme.input_cursor_fg)
                        .bg(self.theme.input_cursor_bg),
                );
            }
            reply_field = Some(field_area);
            y = field_area.bottom() + 1;
        } else if no_target {
            Paragraph::new(Line::from(Span::styled(
                "No agent is running to send a reply to; Mark done closes the card.",
                label,
            )))
            .render(Rect::new(text_x, y, text_width, 1), frame.buffer_mut());
            y += 2;
        }

        // ── Buttons: equal widths across the content, whatever the labels ──
        let count = buttons.len() as u16;
        let each =
            content_width.saturating_sub(BUTTON_GAP * count.saturating_sub(1)) / count.max(1);
        let mut close_area = Rect::default();
        let mut action_area = Rect::default();
        let mut send_area = None;
        let mut assign_area = None;
        for (index, (target, text_label, stop)) in buttons.iter().enumerate() {
            let x = content_x + index as u16 * (each + BUTTON_GAP);
            // The last button takes what rounding left, so the row ends exactly
            // at the content's right edge.
            let w = if index as u16 + 1 == count {
                content_x + content_width - x
            } else {
                each
            };
            let rect = Rect::new(x, y, w, 3);
            Button::new(text_label)
                .kind(ButtonKind::Confirm)
                .state(button_state_for(
                    *target,
                    self.pressed_button,
                    focus == *stop,
                    true,
                ))
                .render(frame, rect, &self.theme);
            match target {
                ButtonPressedTarget::HumanBoardCardClose => close_area = rect,
                ButtonPressedTarget::HumanBoardCardAction => action_area = rect,
                ButtonPressedTarget::HumanBoardCardSend => send_area = Some(rect),
                ButtonPressedTarget::HumanBoardCardAssign => assign_area = Some(rect),
                _ => {}
            }
        }
        y += 3;

        // ── The key line ───────────────────────────────────────────────────
        let field_focused = reply.is_some() && focus == Focus::Reply;
        let confirm_key = self.bindings.label_for(Action::Confirm);
        let close_key = self.bindings.label_for(Action::CloseOverlay);
        let focus_key = if field_focused {
            self.bindings
                .label_for_text_field_dialog(Action::ToggleSelection)
        } else {
            Some(self.bindings.label_for(Action::ToggleSelection))
        };
        let confirm_says = match &reply {
            Some(reply) if field_focused && reply.enter_marks_done() => "send & mark done",
            Some(_) if field_focused => "send",
            _ if focus == Focus::Recipient => "next recipient",
            _ => "press",
        };
        let hints = modal_hint_line(
            &self.theme,
            &[
                Hint::key(confirm_key, confirm_says),
                Hint::maybe_key(focus_key, "focus"),
                Hint::key(close_key, "close"),
            ],
        );
        // The key line starts where the text above it does.
        let mut hint_spans = hints.spans;
        if let Some(first) = hint_spans.first_mut() {
            first.content = first.content.trim_start().to_string().into();
        }
        hint_spans.push(Span::styled("  drag text to copy", label));
        Paragraph::new(Line::from(hint_spans))
            .render(Rect::new(text_x, y, text_width, 1), frame.buffer_mut());

        self.overlay_layout.active = OverlayMouseLayout::HumanBoardCard {
            close_button: close_area,
            action_button: action_area,
            send_button: send_area,
            assign_button: assign_area,
            recipient_chip,
            reply_field,
        };
    }

    /// The Assign picker: one row per person, the card's current one marked.
    pub(super) fn render_assign_board_card_prompt(&mut self, frame: &mut Frame) {
        let PromptState::AssignBoardCard(picker) = &self.prompt else {
            return;
        };
        let people = picker.people.clone();
        let selected = picker.selected;
        let current = picker.card.assignee.clone();
        let label = picker.card.label();
        let me = self
            .human_board
            .settings
            .as_ref()
            .and_then(|settings| settings.me.clone());
        self.render_dim_overlay(frame);
        let width = 64.min(frame.area().width.max(1));
        let height = (people.len() as u16 + 5).min(frame.area().height.max(1));
        let area = centered_rect_exact(width, height, frame.area());
        self.clear_overlay_area(frame, area);
        let title = format!("Assign card {label}");
        let move_up = self.bindings.label_for(Action::MoveUp);
        let move_down = self.bindings.label_for(Action::MoveDown);
        let confirm = self.bindings.label_for(Action::Confirm);
        let close = self.bindings.label_for(Action::CloseOverlay);
        let hints = modal_hint_line(
            &self.theme,
            &[
                Hint::key(format!("{move_up}/{move_down}"), "move"),
                Hint::key(confirm, "assign"),
                Hint::key(close, "back to the card"),
            ],
        );
        let block = self.themed_overlay_block(&title);
        let inner = block.inner(area);
        block.render(area, frame.buffer_mut());
        let content = Rect::new(
            inner.x + PAD,
            inner.y + 1,
            inner.width.saturating_sub(2 * PAD),
            inner.height.saturating_sub(1),
        );
        let same = yaran_core::human_board::same_person;
        let items: Vec<ListItem<'static>> = people
            .iter()
            .map(|person| {
                let mut notes = Vec::new();
                if current.as_deref().is_some_and(|now| same(now, person)) {
                    notes.push("has it now");
                }
                if me.as_deref().is_some_and(|me| same(me, person)) {
                    notes.push("you");
                }
                let note = if notes.is_empty() {
                    String::new()
                } else {
                    format!("  ({})", notes.join(", "))
                };
                ListItem::new(Line::from(vec![
                    Span::styled(person.clone(), Style::default().fg(self.theme.text_fg)),
                    Span::styled(note, Style::default().fg(self.theme.hint_desc_fg)),
                ]))
            })
            .collect();
        let list_area = Rect::new(
            content.x,
            content.y,
            content.width,
            (people.len() as u16).min(content.height.saturating_sub(2)),
        );
        let mut state =
            ListState::default().with_selected(Some(selected.min(people.len().saturating_sub(1))));
        StatefulWidget::render(
            List::new(items).highlight_style(
                Style::default()
                    .fg(self.theme.text_fg)
                    .bg(self.theme.selection_bar_tint()),
            ),
            list_area,
            frame.buffer_mut(),
            &mut state,
        );
        let mut hint_spans = hints.spans;
        if let Some(first) = hint_spans.first_mut() {
            first.content = first.content.trim_start().to_string().into();
        }
        Paragraph::new(Line::from(hint_spans)).render(
            Rect::new(content.x, list_area.bottom() + 1, content.width, 1),
            frame.buffer_mut(),
        );
        self.overlay_layout.active = OverlayMouseLayout::AssignBoardCard {
            list: list_area,
            items: people.len(),
            offset: state.offset(),
        };
    }

    /// The reply field's text width on screen, from the last frame.
    fn board_reply_text_width(&self) -> Option<usize> {
        match self.overlay_layout.active {
            OverlayMouseLayout::HumanBoardCard {
                reply_field: Some(field),
                ..
            } => Some(reply_text_width(field.width)),
            _ => None,
        }
    }

    /// Move the reply's caret `delta` rows up or down its wrapped rows, keeping
    /// its column. `false` when the reply does not have a row there, so the
    /// key can scroll the card instead.
    pub(super) fn move_board_reply_row(&mut self, delta: isize) -> bool {
        let Some(width) = self.board_reply_text_width() else {
            return false;
        };
        let PromptState::HumanBoardCard {
            reply: Some(reply), ..
        } = &mut self.prompt
        else {
            return false;
        };
        let (rows, _, caret_row, caret_col) = reply_window(&reply.input, width, reply.scroll);
        let Some(target) = caret_row
            .checked_add_signed(delta)
            .filter(|row| *row < rows.len())
        else {
            return false;
        };
        reply.input.set_cursor_wrapped(width, target, caret_col);
        reply.scroll = None;
        self.mark_frame_dirty();
        true
    }

    /// Scroll the reply field's window `delta` rows, leaving the caret where it
    /// is (the wheel over the field).
    pub(super) fn scroll_board_reply(&mut self, delta: isize) {
        let Some(width) = self.board_reply_text_width() else {
            return;
        };
        let PromptState::HumanBoardCard {
            reply: Some(reply), ..
        } = &mut self.prompt
        else {
            return;
        };
        let (rows, first, ..) = reply_window(&reply.input, width, reply.scroll);
        let visible = rows.len().clamp(1, REPLY_MAX_ROWS as usize);
        let last_first = rows.len().saturating_sub(visible);
        let next = first.saturating_add_signed(delta).min(last_first);
        reply.scroll = Some(next);
        self.mark_frame_dirty();
    }

    /// A press, drag or release of the left button over the card dialog's
    /// text: select it, and copy the selection when the button comes up.
    /// `None` for anything else, which goes to the dialog's controls.
    pub(super) fn handle_card_text_selection(&mut self, mouse: &MouseEvent) -> Option<bool> {
        let view = &self.human_board.card_view;
        let inside = |column: u16, row: u16| {
            column >= view.body.x
                && column < view.body.right()
                && row >= view.body.y
                && row < view.body.bottom()
        };
        let to_pos = |column: u16, row: u16| TermGridPos {
            row: view.scroll + row.clamp(view.body.y, view.body.bottom().saturating_sub(1))
                - view.body.y,
            col: column.clamp(view.body.x, view.body.right().saturating_sub(1)) - view.body.x,
        };
        let dragging = view.selection.as_ref().is_some_and(|s| s.dragging);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if inside(mouse.column, mouse.row) => {
                let pos = to_pos(mouse.column, mouse.row);
                self.human_board.card_view.selection = Some(TerminalSelection {
                    anchor: pos,
                    end: pos,
                    dragging: true,
                    origin: SelectionOrigin::default(),
                });
                self.mark_frame_dirty();
                Some(false)
            }
            MouseEventKind::Down(MouseButton::Left) => {
                // A press anywhere else drops an old selection and goes on to
                // whatever it landed on.
                if self.human_board.card_view.selection.take().is_some() {
                    self.mark_frame_dirty();
                }
                None
            }
            MouseEventKind::Drag(MouseButton::Left) if dragging => {
                let pos = to_pos(mouse.column, mouse.row);
                if let Some(selection) = self.human_board.card_view.selection.as_mut() {
                    selection.end = pos;
                }
                self.mark_frame_dirty();
                Some(false)
            }
            MouseEventKind::Up(MouseButton::Left) if dragging => {
                let Some(selection) = self.human_board.card_view.selection.as_mut() else {
                    return Some(false);
                };
                selection.dragging = false;
                if selection.anchor == selection.end {
                    self.human_board.card_view.selection = None;
                } else {
                    self.copy_card_selection();
                }
                self.mark_frame_dirty();
                Some(false)
            }
            _ => None,
        }
    }

    /// Copy the selected part of the card's text to the clipboard: rows a
    /// soft wrap split are joined with a space, real line breaks are kept.
    fn copy_card_selection(&mut self) {
        let view = &self.human_board.card_view;
        let Some(selection) = view.selection.clone() else {
            return;
        };
        let text = selected_card_text(&view.rows, &view.continues, &selection);
        if text.trim().is_empty() {
            return;
        }
        let _ = self.clipboard.copy_text(
            &text,
            "Copied the selected text of the card to the clipboard.",
            &self.engine.worker_tx,
        );
    }
}

/// The text `selection` covers in `rows`, joining a row that continues the
/// one above (`continues`) with a space and anything else with a line break.
pub(crate) fn selected_card_text(
    rows: &[String],
    continues: &[bool],
    selection: &TerminalSelection,
) -> String {
    let (start, end) = selection.ordered();
    let mut out = String::new();
    for row in start.row..=end.row {
        let Some(line) = rows.get(usize::from(row)) else {
            continue;
        };
        let from = if row == start.row {
            usize::from(start.col)
        } else {
            0
        };
        let to = if row == end.row {
            usize::from(end.col) + 1
        } else {
            usize::MAX
        };
        let piece: String = line
            .chars()
            .skip(from)
            .take(to.saturating_sub(from))
            .collect();
        if row > start.row && continues.get(usize::from(row)).copied().unwrap_or(false) {
            out.push(' ');
            out.push_str(piece.trim());
        } else {
            if row > start.row {
                out.push('\n');
            }
            out.push_str(piece.trim_end());
        }
    }
    out.trim_matches('\n').to_string()
}
