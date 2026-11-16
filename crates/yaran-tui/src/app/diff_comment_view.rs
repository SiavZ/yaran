//! The diff view's drawing for diff comments: the marker column, the cursor
//! line's highlight, the comment boxes slotted under their lines, the
//! scroll that keeps a moved cursor in view, and the comment editor's labels.
//! The state and the acts live in [`super::diff_comments`].

use std::sync::Arc;

use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Paragraph, Widget};
use yaran_core::diff_comments::{DiffAnchor, DiffSide, count_label};

use super::components::Hint;
use super::components::wrap_lines::wrap_styled_lines;
use super::{App, CenterMode};
use crate::keybindings::Action;

/// One comment box drawn under the last row of the line it is about.
pub(crate) struct CommentBox {
    /// The wrapped diff row the box follows.
    pub(crate) after_row: usize,
    /// The box's own rows.
    pub(crate) rows: Vec<Line<'static>>,
}

/// One row of the diff pane as drawn: a wrapped diff row, or a row of a box.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PaneRow {
    Diff(usize),
    Box { index: usize, row: usize },
}

/// The pane's rows from `start`, at most `height` of them, for `wrapped`
/// wrapped diff rows with `boxes` (ordered by `after_row`) slotted in.
pub(crate) fn pane_window(
    wrapped: usize,
    boxes: &[CommentBox],
    start: usize,
    height: usize,
) -> Vec<PaneRow> {
    let mut out = Vec::with_capacity(height);
    let mut display = 0usize;
    let mut next_box = 0usize;
    for row in 0..wrapped {
        if out.len() >= height {
            break;
        }
        if display >= start {
            out.push(PaneRow::Diff(row));
        }
        display += 1;
        while let Some(boxed) = boxes.get(next_box).filter(|b| b.after_row == row) {
            for box_row in 0..boxed.rows.len() {
                if display >= start && out.len() < height {
                    out.push(PaneRow::Box {
                        index: next_box,
                        row: box_row,
                    });
                }
                display += 1;
            }
            next_box += 1;
        }
    }
    out
}

/// Where wrapped row `row` is drawn, counting the box rows above it.
pub(crate) fn display_row(row: usize, boxes: &[CommentBox]) -> usize {
    row + boxes
        .iter()
        .filter(|b| b.after_row < row)
        .map(|b| b.rows.len())
        .sum::<usize>()
}

impl App {
    /// The editor's label lines: the line being commented on, as a chip, and
    /// its text.
    pub(crate) fn diff_comment_labels(&self, anchor: &DiffAnchor) -> Vec<Line<'static>> {
        let label = Style::default().fg(self.theme.input_label_fg);
        let side = match anchor.side {
            DiffSide::Old => " (removed)",
            DiffSide::New => "",
        };
        vec![
            Line::from(vec![
                Span::styled(" On ", label),
                super::components::name_chip(&anchor.rel_path, &self.theme),
                Span::styled(format!(" line {}{side}:", anchor.line_number), label),
            ]),
            Line::from(Span::styled(
                format!("   {}", anchor.line_content.trim_end()),
                Style::default().fg(self.theme.hint_desc_fg),
            )),
            Line::from(Span::styled(
                " Your comment for the agent (empty removes it):",
                label,
            )),
        ]
    }

    /// A changed file's right-hand figures, led by a flag and the number of
    /// comments the selected agent has queued on it.
    pub(crate) fn with_diff_comment_flag(
        &self,
        file: &yaran_core::model::ChangedFile,
        stats: Vec<Span<'static>>,
    ) -> Vec<Span<'static>> {
        let queued = self.diff_comment_count_for_path(&file.path);
        if queued == 0 || file.is_folder() {
            return stats;
        }
        let mut flagged = vec![Span::styled(
            format!("⚑{queued}"),
            Style::default().fg(self.theme.warning_fg),
        )];
        if !stats.is_empty() {
            flagged.push(Span::raw(" "));
        }
        flagged.extend(stats);
        flagged
    }

    /// The diff footer for a diff that takes comments: the line keys move the
    /// cursor, so they are named for that, beside the comment and send keys.
    /// `None` for a diff that takes none, which keeps its scrolling footer.
    pub(crate) fn diff_comment_hints(
        &self,
        close: String,
        scroll: [String; 2],
    ) -> Option<Vec<Hint>> {
        self.current_diff_anchors()?;
        let label = |action| self.bindings.label_for(action);
        let mut hints = vec![
            Hint::keys(
                [label(Action::ScrollLineUp), label(Action::ScrollLineDown)],
                "line",
            ),
            Hint::key(label(Action::CommentDiffLine), "comment"),
        ];
        let queued = self.selected_diff_comments().len();
        if queued > 0 {
            hints.push(Hint::key(
                label(Action::SendDiffComments),
                format!("send {}", count_label(queued)),
            ));
        }
        hints.push(Hint::keys(scroll, "scroll"));
        hints.push(Hint::key(close, "close diff").pinned());
        Some(hints)
    }

    /// The boxes the selected agent's comments on the diff on screen draw,
    /// for wrapped rows whose sources are `sources`, at `width` columns.
    pub(crate) fn diff_comment_boxes(&self, sources: &[usize], width: usize) -> Vec<CommentBox> {
        let Some(anchors) = self.current_diff_anchors() else {
            return Vec::new();
        };
        let border = Style::default().fg(self.theme.warning_fg);
        let text = Style::default().fg(self.theme.text_fg);
        let mut boxes: Vec<CommentBox> = Vec::new();
        for comment in self.selected_diff_comments() {
            let Some(line) = anchors
                .iter()
                .position(|a| a.as_ref() == Some(&comment.anchor))
            else {
                continue;
            };
            let after = sources.partition_point(|&s| s <= line);
            let Some(after_row) = after.checked_sub(1).filter(|&r| sources[r] == line) else {
                continue;
            };
            let body: Vec<Line<'_>> = comment.text.lines().map(Line::from).collect();
            let mut rows = vec![Line::from(Span::styled("╭ comment", border))];
            for wrapped in wrap_styled_lines(&body, width.saturating_sub(2).max(1)) {
                let mut spans = vec![Span::styled("│ ", border)];
                spans.extend(wrapped.spans.into_iter().map(|s| s.patch_style(text)));
                rows.push(Line::from(spans));
            }
            rows.push(Line::from(Span::styled("╰", border)));
            boxes.push(CommentBox { after_row, rows });
        }
        boxes.sort_by_key(|b| b.after_row);
        boxes
    }
}

impl App {
    /// The pane's two marker columns and the text beside them, or no marker
    /// column at all for a diff that takes no comments.
    pub(crate) fn split_diff_marker_column(&self, area: Rect) -> (Rect, Rect) {
        if self.current_diff_anchors().is_none() || area.width <= 4 {
            return (Rect { width: 0, ..area }, area);
        }
        let marker = Rect { width: 2, ..area };
        let text = Rect {
            x: area.x + 2,
            width: area.width - 2,
            ..area
        };
        (marker, text)
    }

    /// The comment boxes for this frame, when the wrapped rows on hand belong
    /// to the diff on screen.
    pub(crate) fn diff_comment_boxes_for_frame(&self, width: usize) -> Vec<CommentBox> {
        let (Some(cache), CenterMode::Diff { lines, .. }) = (&self.diff_rows, &self.center_mode)
        else {
            return Vec::new();
        };
        if !Arc::ptr_eq(&cache.lines, lines) {
            return Vec::new();
        }
        self.diff_comment_boxes(&cache.sources, width)
    }

    /// Scroll a cursor that just moved into view, its comment box included,
    /// and answer the scroll to draw from.
    pub(crate) fn follow_diff_cursor(
        &mut self,
        boxes: &[CommentBox],
        scroll: usize,
        height: u16,
    ) -> usize {
        if !std::mem::take(&mut self.diff_comments.follow_cursor) {
            return scroll;
        }
        let (Some(cursor), Some(cache)) = (self.diff_comments.cursor, self.diff_rows.as_ref())
        else {
            return scroll;
        };
        let first = cache.sources.partition_point(|&s| s < cursor);
        let end = cache.sources.partition_point(|&s| s <= cursor);
        if first >= end {
            return scroll;
        }
        let last = end - 1;
        let top = display_row(first, boxes);
        let bottom = display_row(last, boxes)
            + boxes
                .iter()
                .filter(|b| b.after_row == last)
                .map(|b| b.rows.len())
                .sum::<usize>();
        let height = usize::from(height.max(1));
        let next = if top < scroll {
            top
        } else if bottom >= scroll + height {
            (bottom + 1).saturating_sub(height).min(top)
        } else {
            scroll
        };
        if let CenterMode::Diff { scroll, .. } = &mut self.center_mode {
            *scroll = next;
        }
        next
    }

    /// Draw the window of the diff pane that starts at display row `start`:
    /// its wrapped rows with the cursor's line highlighted, the comment boxes
    /// between them, and the markers (a flag on a commented line, a pointer on
    /// the cursor's) in the marker column.
    pub(crate) fn draw_diff_window(
        &mut self,
        frame: &mut Frame<'_>,
        (marker_area, text_area): (Rect, Rect),
        boxes: &[CommentBox],
        start: usize,
    ) {
        let cursor = self
            .diff_comments
            .cursor
            .filter(|_| self.current_diff_anchors().is_some());
        let Some(cache) = self.diff_rows.as_ref() else {
            self.diff_comments.visible_span = None;
            self.diff_comments.drawn_rows = None;
            return;
        };
        let window = pane_window(
            cache.rows.len(),
            boxes,
            start,
            usize::from(text_area.height),
        );
        let commented: Vec<usize> = boxes.iter().map(|b| cache.sources[b.after_row]).collect();
        let selection = self.theme.selection_style();
        let flag = Style::default().fg(self.theme.warning_fg);
        let pointer = Style::default().fg(self.theme.hint_key_fg);
        let mut text = Vec::with_capacity(window.len());
        let mut marks = Vec::with_capacity(window.len());
        let mut span: Option<(usize, usize)> = None;
        let mut drawn = Vec::with_capacity(window.len());
        for row in window {
            match row {
                PaneRow::Diff(r) => {
                    let source = cache.sources[r];
                    drawn.push(Some(source));
                    span = Some(span.map_or((source, source), |(first, _)| (first, source)));
                    let first_row = r == 0 || cache.sources[r - 1] != source;
                    let on_cursor = cursor == Some(source);
                    let line = &cache.rows[r];
                    text.push(if on_cursor {
                        Line::from(
                            line.spans
                                .iter()
                                .map(|s| s.clone().patch_style(selection))
                                .collect::<Vec<_>>(),
                        )
                    } else {
                        line.clone()
                    });
                    marks.push(if first_row && commented.contains(&source) {
                        Line::from(Span::styled("⚑", flag))
                    } else if first_row && on_cursor {
                        Line::from(Span::styled("›", pointer))
                    } else {
                        Line::default()
                    });
                }
                PaneRow::Box { index, row } => {
                    drawn.push(None);
                    text.push(boxes[index].rows[row].clone());
                    marks.push(Line::default());
                }
            }
        }
        self.diff_comments.visible_span = span;
        self.diff_comments.drawn_rows = Some((text_area, drawn));
        Paragraph::new(text).render(text_area, frame.buffer_mut());
        if marker_area.width > 0 {
            Paragraph::new(marks).render(marker_area, frame.buffer_mut());
        }
    }
}

#[cfg(test)]
#[path = "diff_comment_view_tests.rs"]
mod tests;
