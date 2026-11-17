//! The diff pane's layout with comment boxes slotted in, and what a frame
//! draws for the cursor and the queued comments.

use super::{CommentBox, PaneRow, display_row, pane_window};
use ratatui::text::Line;

fn boxed(after_row: usize, rows: usize) -> CommentBox {
    CommentBox {
        after_row,
        rows: vec![Line::from("x"); rows],
    }
}

#[test]
fn boxes_slot_in_after_their_row_and_count_toward_the_window() {
    let boxes = [boxed(0, 2), boxed(2, 1)];
    let all = pane_window(3, &boxes, 0, 100);
    assert_eq!(
        all,
        vec![
            PaneRow::Diff(0),
            PaneRow::Box { index: 0, row: 0 },
            PaneRow::Box { index: 0, row: 1 },
            PaneRow::Diff(1),
            PaneRow::Diff(2),
            PaneRow::Box { index: 1, row: 0 },
        ]
    );
    assert_eq!(pane_window(3, &boxes, 2, 2), all[2..4].to_vec());
    assert_eq!(display_row(1, &boxes), 3);
    assert_eq!(display_row(2, &boxes), 4);
    assert_eq!(pane_window(3, &[], 5, 10), Vec::<PaneRow>::new());
}
