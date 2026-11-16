//! Diff comments in the terminal UI: the line cursor in the diff view, the
//! queued comments drawn under their lines, the comment editor, and the send
//! that types the queue into the selected agent's prompt.
//!
//! The model, the prompt and the storage live in `yaran_core::diff_comments`
//! and the session store. The editor is the `Configure*` family's modal (one
//! full-text field with an engage step, plus Cancel and Save), so it inherits
//! that family's keys, mouse routing and footer. The send writes through the
//! pty ownership gate like every other keystroke from this surface, and it
//! only TYPES the comments: the person reviews them in the agent's prompt and
//! presses Enter there.

use std::sync::Arc;

use ratatui::crossterm::event::KeyEvent;
use ratatui::text::Line;
use yaran_core::diff_comments::{DiffAnchor, DiffComment, count_label, render_prompt};
use yaran_core::ids::TabIdRef;

use super::text_input::TextInput;
use super::{
    App, CenterMode, ConfigureFieldFocus, FocusPane, InputTarget, PromptState, SessionSurface,
};
use crate::keybindings::{Action, BindingScope};

/// One diff's anchors, one per row of its lines.
pub(crate) type DiffAnchors = Arc<Vec<Option<DiffAnchor>>>;

/// What the diff view knows about comments.
#[derive(Default)]
pub(crate) struct DiffCommentsUi {
    /// Every queued comment, for every agent, as stored.
    pub(crate) queued: Vec<DiffComment>,
    /// The anchors of the diff on screen, kept with the lines they describe so
    /// a recomputed diff can never be read through the previous one's anchors.
    pub(crate) anchors: Option<(Arc<Vec<Line<'static>>>, DiffAnchors)>,
    /// The line under the cursor, as an index into the diff's lines.
    pub(crate) cursor: Option<usize>,
    /// Set when the cursor moved, so the next frame scrolls it into view.
    pub(crate) follow_cursor: bool,
    /// The first and last diff line the last frame showed.
    pub(crate) visible_span: Option<(usize, usize)>,
    /// Where the last frame drew the diff's text, and the diff line on each of
    /// its rows (`None` on a comment box), so a click finds its line.
    pub(crate) drawn_rows: Option<(ratatui::layout::Rect, Vec<Option<usize>>)>,
}

impl App {
    /// The comments queued for the selected agent.
    pub(crate) fn selected_diff_comments(&self) -> Vec<&DiffComment> {
        let Some(session) = self.selected_session() else {
            return Vec::new();
        };
        self.diff_comments
            .queued
            .iter()
            .filter(|comment| comment.session_id == session.id)
            .collect()
    }

    /// How many comments the selected agent has queued on `rel_path`.
    pub(crate) fn diff_comment_count_for_path(&self, rel_path: &str) -> usize {
        self.selected_diff_comments()
            .iter()
            .filter(|comment| comment.anchor.rel_path == rel_path)
            .count()
    }

    /// The anchors of the diff on screen, when it has any.
    pub(crate) fn current_diff_anchors(&self) -> Option<DiffAnchors> {
        let CenterMode::Diff { lines, .. } = &self.center_mode else {
            return None;
        };
        let (for_lines, anchors) = self.diff_comments.anchors.as_ref()?;
        Arc::ptr_eq(for_lines, lines).then(|| Arc::clone(anchors))
    }

    /// Take a landed diff's anchors, put the cursor on its first commentable
    /// line, and drop the selected agent's comments on this file whose line is
    /// no longer in it (its text changed, or the file stopped changing).
    pub(crate) fn adopt_diff_anchors(
        &mut self,
        lines: &Arc<Vec<Line<'static>>>,
        anchors: Option<Vec<Option<DiffAnchor>>>,
        rel_path: &str,
    ) {
        let Some(anchors) = anchors else {
            self.diff_comments.anchors = None;
            self.diff_comments.cursor = None;
            return;
        };
        let keep = self
            .diff_comments
            .cursor
            .filter(|&index| anchors.get(index).is_some_and(Option::is_some));
        self.diff_comments.cursor = keep.or_else(|| anchors.iter().position(Option::is_some));
        let anchors = Arc::new(anchors);
        self.diff_comments.anchors = Some((Arc::clone(lines), Arc::clone(&anchors)));
        let Some(session_id) = self.selected_session().map(|s| s.id.clone()) else {
            return;
        };
        let stale: Vec<DiffAnchor> = self
            .diff_comments
            .queued
            .iter()
            .filter(|c| c.session_id == session_id && c.anchor.rel_path == rel_path)
            .filter(|c| !anchors.iter().flatten().any(|a| *a == c.anchor))
            .map(|c| c.anchor.clone())
            .collect();
        if stale.is_empty() {
            return;
        }
        for anchor in &stale {
            if let Err(err) = self
                .engine
                .session_store
                .delete_diff_comment(&session_id, anchor)
            {
                self.set_error(format!(
                    "Could not drop a stale diff comment on {rel_path}: {err:#}. It stays queued."
                ));
                return;
            }
        }
        self.diff_comments
            .queued
            .retain(|c| !(c.session_id == session_id && stale.contains(&c.anchor)));
        self.set_info(format!(
            "Dropped {} on {rel_path}: the lines they were written about changed.",
            count_label(stale.len())
        ));
    }

    /// Move the cursor `delta` commentable lines. `false` when the diff on
    /// screen has none, so the caller scrolls instead. A cursor the view has
    /// scrolled away from first comes back to the nearest line in view.
    pub(crate) fn move_diff_cursor(&mut self, delta: isize) -> bool {
        let Some(anchors) = self.current_diff_anchors() else {
            return false;
        };
        let commentable: Vec<usize> = anchors
            .iter()
            .enumerate()
            .filter_map(|(index, anchor)| anchor.as_ref().map(|_| index))
            .collect();
        if commentable.is_empty() {
            return false;
        }
        let in_view = |index: usize| {
            self.diff_comments
                .visible_span
                .is_none_or(|(first, last)| (first..=last).contains(&index))
        };
        let next = if let Some(current) = self.diff_comments.cursor.filter(|&c| in_view(c)) {
            let at = commentable.iter().position(|&i| i >= current).unwrap_or(0);
            let at = at.saturating_add_signed(delta).min(commentable.len() - 1);
            commentable[at]
        } else {
            // Back to the nearest commentable line in view, or the first after
            // the top of the view when none is in it.
            let pick = if delta < 0 {
                commentable.iter().rev().find(|&&i| in_view(i))
            } else {
                commentable.iter().find(|&&i| in_view(i))
            };
            pick.copied()
                .or_else(|| {
                    let first = self.diff_comments.visible_span?.0;
                    commentable.iter().copied().find(|&i| i >= first)
                })
                .unwrap_or(commentable[0])
        };
        self.diff_comments.cursor = Some(next);
        self.diff_comments.follow_cursor = true;
        true
    }

    /// The diff view's own keys: commenting and sending, which the diff scope
    /// binds, and the line keys, which move the cursor in a diff that takes
    /// comments (and scroll, through the caller, in one that does not).
    pub(crate) fn handle_diff_comment_key(&mut self, key: &KeyEvent) -> bool {
        match self.bindings.lookup(key, BindingScope::Diff) {
            Some(Action::CommentDiffLine) => {
                self.open_diff_comment_editor();
                return true;
            }
            Some(Action::SendDiffComments) => {
                self.send_diff_comments();
                return true;
            }
            _ => {}
        }
        match self.bindings.lookup(key, BindingScope::Center) {
            Some(Action::ScrollLineUp) => self.move_diff_cursor(-1),
            Some(Action::ScrollLineDown) => self.move_diff_cursor(1),
            _ => false,
        }
    }

    /// A left click on the diff's text: put the cursor on the commentable line
    /// under it, and open the editor on a second click on that same line (a
    /// double click acts on the item it lands on, never on the pane). `false`
    /// when the click is not on such a line, so the pane handles it as before.
    pub(crate) fn click_diff_line(&mut self, column: u16, row: u16) -> bool {
        let Some(anchors) = self.current_diff_anchors() else {
            return false;
        };
        let Some((area, rows)) = &self.diff_comments.drawn_rows else {
            return false;
        };
        if !super::input::contains_point(*area, column, row) {
            return false;
        }
        let Some(line) = rows
            .get(usize::from(row - area.y))
            .copied()
            .flatten()
            .filter(|&line| anchors.get(line).is_some_and(Option::is_some))
        else {
            return false;
        };
        self.diff_comments.cursor = Some(line);
        if self.register_mouse_click(super::MouseClickTarget::CenterPane, Some(line)) {
            self.open_diff_comment_editor();
        }
        true
    }

    /// The line under the cursor, when the diff on screen has one.
    fn diff_cursor_anchor(&self) -> Option<DiffAnchor> {
        let anchors = self.current_diff_anchors()?;
        anchors.get(self.diff_comments.cursor?)?.clone()
    }

    /// Open the comment editor on the line under the cursor, holding the
    /// comment already queued there, if any.
    pub(crate) fn open_diff_comment_editor(&mut self) {
        let Some(session_id) = self.selected_session().map(|s| s.id.clone()) else {
            self.set_warning("Select an agent first: diff comments are queued per agent.");
            return;
        };
        let Some(anchor) = self.diff_cursor_anchor() else {
            self.set_warning(
                "This diff has no line to comment on: comments go on the added, removed and \
                 unchanged lines of a diff yaran computed itself.",
            );
            return;
        };
        let existing = self
            .diff_comments
            .queued
            .iter()
            .find(|c| c.session_id == session_id && c.anchor == anchor)
            .map(|c| c.text.clone())
            .unwrap_or_default();
        let rows = usize::from(self.engine.config.ui.diff_comment_editor_max_lines.max(1));
        self.input_target = InputTarget::None;
        self.prompt = PromptState::CommentDiffLine {
            session_id,
            anchor,
            input: TextInput::with_text(existing)
                .with_multiline(rows)
                .with_placeholder("What should the agent change about this line?"),
            focus: ConfigureFieldFocus::default(),
        };
    }

    /// Save the editor's comment (an empty one removes it) and close it. A
    /// write the store refuses keeps the editor open with the text in it.
    pub(crate) fn apply_diff_comment_prompt(&mut self) {
        let PromptState::CommentDiffLine {
            session_id,
            anchor,
            input,
            ..
        } = &self.prompt
        else {
            return;
        };
        let comment = DiffComment {
            session_id: session_id.clone(),
            anchor: anchor.clone(),
            text: input.text.trim().to_string(),
        };
        let line = format!(
            "{} line {}",
            comment.anchor.rel_path, comment.anchor.line_number
        );
        let store = &self.engine.session_store;
        let written = if comment.text.is_empty() {
            store.delete_diff_comment(&comment.session_id, &comment.anchor)
        } else {
            store.upsert_diff_comment(&comment)
        };
        if let Err(err) = written {
            self.set_error(format!(
                "Could not save the comment on {line}: {err:#}. Your text is still in the editor."
            ));
            return;
        }
        let removing = comment.text.is_empty();
        let before = self.diff_comments.queued.len();
        self.diff_comments
            .queued
            .retain(|c| !(c.session_id == comment.session_id && c.anchor == comment.anchor));
        if !removing {
            self.diff_comments.queued.push(comment);
        }
        self.prompt = PromptState::None;
        self.input_target = InputTarget::None;
        let queued = self.selected_diff_comments().len();
        let send = self.bindings.label_for(Action::SendDiffComments);
        self.set_info(if removing && before == self.diff_comments.queued.len() {
            format!(
                "No comment was queued on {line}. {} still queued.",
                count_label(queued)
            )
        } else if removing {
            format!(
                "Removed the comment on {line}. {} still queued.",
                count_label(queued)
            )
        } else {
            format!(
                "Queued a comment on {line}; {} queued for this agent. Press {send} in the diff \
                 view to type them into its prompt.",
                count_label(queued)
            )
        });
    }

    /// Type the selected agent's queued comments into the prompt of its
    /// focused tab, through the ownership gate, without pressing Enter: the
    /// person reviews them there. The queue is cleared once they are typed.
    pub(crate) fn send_diff_comments(&mut self) {
        let Some(session) = self.selected_session() else {
            self.set_warning("Select an agent first: diff comments are queued per agent.");
            return;
        };
        let session_id = session.id.clone();
        let label = session.display_label();
        let comments = self.selected_diff_comments();
        let count = comments.len();
        let defaults = &self.engine.config.defaults;
        let Some(prompt) = render_prompt(
            &comments,
            &defaults.diff_comment_prompt_template,
            &defaults.diff_comment_prompt_separator,
        ) else {
            self.set_info(format!(
                "No diff comments are queued for {label}. Open a file's diff and comment on a \
                 line first."
            ));
            return;
        };
        let tab_id = self.focused_tab_id(&session_id);
        if !self.engine.providers.contains_key(TabIdRef::new(&tab_id)) {
            self.set_warning(format!(
                "Did not send: {label} is not running. Start it, then send again; the {} stay \
                 queued.",
                count_label(count)
            ));
            return;
        }
        if let Some(reason) = self.agent_tab_write_refusal(&tab_id) {
            self.set_warning(format!(
                "Did not send the {} to {label}: {reason} They stay queued.",
                count_label(count)
            ));
            return;
        }
        if self.engine.is_agent_streaming(&tab_id) {
            self.set_warning(format!(
                "Did not send: {label} is still working. Send again once it is idle; the {} stay \
                 queued.",
                count_label(count)
            ));
            return;
        }
        let bytes =
            yaran_core::macros::macro_payload_bytes(&yaran_core::sanitize::for_terminal(&prompt));
        if !self.write_into_agent_tab(&tab_id, &bytes) {
            self.set_warning(format!(
                "Did not send the {} to {label}: its terminal refused the keystrokes. They stay \
                 queued.",
                count_label(count)
            ));
            return;
        }
        self.engine.note_pty_used(&tab_id, &bytes);
        self.close_diff_view();
        self.session_surface = SessionSurface::Agent;
        self.focus = FocusPane::Center;
        if let Err(err) = self
            .engine
            .session_store
            .delete_diff_comments_for_session(&session_id)
        {
            self.set_error(format!(
                "Typed the {} into {label}'s prompt, but could not clear them from the queue: \
                 {err:#}. Remove them by hand before sending again.",
                count_label(count)
            ));
            return;
        }
        self.diff_comments
            .queued
            .retain(|c| c.session_id != session_id);
        self.set_info(format!(
            "Typed {} into {label}'s prompt. Review them there and press Enter to send.",
            count_label(count)
        ));
    }
}

#[cfg(test)]
#[path = "diff_comments_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "diff_comments_delivery_tests.rs"]
mod delivery_tests;
