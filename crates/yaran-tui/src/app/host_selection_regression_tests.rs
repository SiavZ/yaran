//! Isolated host-selection regressions. The only child is a private shell script
//! that writes its own terminal output after scratch-file barriers. Tests never
//! write directly to a PTY or reach the system clipboard. The one release test
//! explicitly replaces the defused clipboard with a captured in-memory callback.

use super::*;
use crate::app::test_support::{default_bindings, test_app};
use crate::pty::PtyClient;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use yaran_core::ids::TabId;

struct OutputFixture {
    directory: TempDir,
    next_phase: usize,
}

impl OutputFixture {
    fn advance(&mut self) {
        std::fs::write(
            self.directory
                .path()
                .join(format!("phase-{}", self.next_phase)),
            b"continue",
        )
        .expect("advance private output fixture");
        self.next_phase += 1;
    }
}

fn shell_printf(bytes: &str) -> String {
    let encoded: String = bytes.bytes().map(|byte| format!("\\0{byte:03o}")).collect();
    format!("printf '%b' '{encoded}'\n")
}

fn numbered_lines(count: usize) -> String {
    (0..count).map(|n| format!("L{n:02}\r\n")).collect()
}

fn fixture(scrollback: usize, initial: &str, phases: &[&str]) -> (App, OutputFixture) {
    let directory = tempfile::tempdir().expect("private terminal output directory");
    let mut script = shell_printf(initial);
    for (index, output) in phases.iter().enumerate() {
        script.push_str(&format!(
            "n=0\nwhile [ ! -f \"$1/phase-{index}\" ]; do\n  n=$((n + 1))\n  [ \"$n\" -lt 1000 ] || exit 71\n  sleep 0.01\ndone\n"
        ));
        script.push_str(&shell_printf(output));
    }
    // Keep the child alive until the test drops it, without reading any input.
    script.push_str("n=0\nwhile [ \"$n\" -lt 1000 ]; do sleep 0.01; n=$((n + 1)); done\n");
    let script_path = directory.path().join("output-only.sh");
    std::fs::write(&script_path, script).expect("write private output-only child");
    let args = vec![
        script_path.to_string_lossy().into_owned(),
        directory.path().to_string_lossy().into_owned(),
    ];
    let client = PtyClient::spawn("/bin/sh", &args, directory.path(), 24, 80, scrollback)
        .expect("spawn private output-only shell");
    let mut app = test_app(default_bindings());
    let tab_id = app.engine.sessions[0].slot_tab_id().to_string();
    app.engine.providers.insert(TabId::new(tab_id), client);
    app.session_surface = SessionSurface::Agent;
    app.focus = FocusPane::Center;
    app.mouse_layout.center = Rect::new(9, 1, 82, 26);
    app.mouse_layout.agent_term = Some(Rect::new(10, 2, 80, 24));
    app.engine.sessions[0].provider = ProviderKind::from_str("jcode");
    let policy = app
        .engine
        .config
        .providers
        .commands
        .get_mut("jcode")
        .expect("harmless fixture includes jcode config");
    policy.forward_mouse = Some(false);
    policy.forward_scroll = Some(true);
    (
        app,
        OutputFixture {
            directory,
            next_phase: 0,
        },
    )
}

fn row_text(app: &App, row: u16) -> String {
    app.snapshot_buf
        .cells
        .iter()
        .filter(|cell| cell.row == row)
        .map(|cell| cell.symbol.as_str())
        .collect::<String>()
        .trim_end()
        .to_string()
}

fn wait_for_text(app: &mut App, needle: &str) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        app.refresh_snapshot_buf();
        if let Some(row) = (0..app.snapshot_buf.rows).find(|row| row_text(app, *row) == needle) {
            return row;
        }
        assert!(
            Instant::now() < deadline,
            "private output did not show {needle:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn mouse_event(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

fn select_host_row(app: &mut App, needle: &str) {
    let row = wait_for_text(app, needle);
    let area = app.mouse_layout.agent_term.expect("private pane geometry");
    app.handle_mouse(mouse_event(
        MouseEventKind::Down(MouseButton::Left),
        area.x,
        area.y + row,
    ));
    app.handle_mouse(mouse_event(
        MouseEventKind::Drag(MouseButton::Left),
        area.x + needle.len() as u16 - 1,
        area.y + row,
    ));
    assert!(app.center_mouse_forward.is_none(), "host owns the drag");
    let selection = app.terminal_selection.as_ref().expect("host drag selects");
    assert!(selection.dragging);
    assert_ne!(selection.anchor, selection.end);
    assert_eq!(app.terminal_selection_text(), needle);
}

#[test]
fn host_selection_crossing_history_capacity_never_copies_different_text() {
    let initial = format!("\x1b[?1002h{}", numbered_lines(27));
    let (mut app, mut output) = fixture(5, &initial, &["M00\r\nM01\r\nM02\r\n"]);
    wait_for_text(&mut app, "L26");
    select_host_row(&mut app, "L20");
    assert_eq!(app.snapshot_buf.scrollback_total, 4);
    assert!(!app.snapshot_selection_origin().history_saturated);

    output.advance();
    wait_for_text(&mut app, "M02");
    assert_eq!(app.snapshot_buf.scrollback_total, 5);
    assert!(app.snapshot_selection_origin().history_saturated);
    assert_eq!(
        app.terminal_selection_text(),
        "",
        "a selection that crossed and rotated the history cap must retire, not silently copy another row"
    );
}

#[test]
fn host_selection_below_history_capacity_follows_the_selected_text() {
    let initial = format!("\x1b[?1002h{}", numbered_lines(27));
    let (mut app, mut output) = fixture(64, &initial, &["M00\r\nM01\r\nM02\r\n"]);
    wait_for_text(&mut app, "L26");
    select_host_row(&mut app, "L20");
    output.advance();
    wait_for_text(&mut app, "M02");
    assert_eq!(app.snapshot_buf.scrollback_total, 7);
    assert_eq!(app.terminal_selection_text(), "L20");
}

#[test]
fn host_selection_alt_screen_does_not_inherit_saturated_main_history() {
    let initial = format!("\x1b[?1002h{}", numbered_lines(40));
    let (mut app, mut output) = fixture(
        5,
        &initial,
        &[
            "\x1b[?1049h\x1b[2J\x1b[3;1HSTATIC TARGET",
            "\x1b[10;1HUNRELATED REPAINT",
        ],
    );
    wait_for_text(&mut app, "L39");
    assert_eq!(app.snapshot_buf.scrollback_total, 5);
    output.advance();
    select_host_row(&mut app, "STATIC TARGET");
    assert_eq!(app.snapshot_buf.scrollback_total, 0);
    assert!(!app.snapshot_selection_origin().history_saturated);
    output.advance();
    wait_for_text(&mut app, "UNRELATED REPAINT");
    assert_eq!(app.terminal_selection_text(), "STATIC TARGET");
}

#[test]
fn host_selection_width_change_retires_the_old_coordinates() {
    let initial = format!("\x1b[?1002h{}", numbered_lines(27));
    let (mut app, _output) = fixture(64, &initial, &[]);
    wait_for_text(&mut app, "L26");
    select_host_row(&mut app, "L20");
    app.selected_terminal_surface_client()
        .expect("private child")
        .resize(24, 70)
        .expect("resize only the private fixture");
    assert_eq!(app.terminal_selection_text(), "");
}

fn first_drag_after_saturated_repaint(initial_lines: usize, repaint: &str, sentinel: &str) {
    let initial = format!("\x1b[?1002h{}", numbered_lines(initial_lines));
    let (mut app, mut output) = fixture(5, &initial, &[repaint]);
    wait_for_text(&mut app, &format!("L{:02}", initial_lines - 1));
    let row = wait_for_text(&mut app, "L20");
    let area = app.mouse_layout.agent_term.expect("private pane geometry");
    app.handle_mouse(mouse_event(
        MouseEventKind::Down(MouseButton::Left),
        area.x,
        area.y + row,
    ));
    let origin = app
        .terminal_selection
        .as_ref()
        .expect("pending host click")
        .origin;
    assert_eq!(origin.history_saturated, initial_lines == 40);

    output.advance();
    wait_for_text(&mut app, sentinel);
    assert!(app.snapshot_selection_origin().history_saturated);
    assert_ne!(app.grid_generation, origin.grid_generation);
    // Match the render lifecycle between the press and the first real motion.
    // A fix may retain a zero-extent carrier solely for click replay, but must
    // never re-stamp that carrier into a valid selection at the new generation.
    app.drop_drifted_selection();
    if let Some(selection) = &app.terminal_selection {
        assert!(selection.dragging);
        assert_eq!(selection.anchor, selection.end);
        assert_eq!(selection.origin, origin, "do not silently re-anchor text");
    }

    app.handle_mouse(mouse_event(
        MouseEventKind::Drag(MouseButton::Left),
        area.x + 2,
        area.y + row,
    ));
    assert!(
        app.terminal_selection.is_none(),
        "first motion must cancel an unfollowable pending click before extending its stale text coordinates"
    );
    assert_eq!(app.terminal_selection_text(), "");
}

#[test]
fn host_selection_first_drag_after_saturated_repaint_cannot_extend_stale_click() {
    first_drag_after_saturated_repaint(40, "\x1b[20;1H\x1b[2KREPAINT", "REPAINT");
}

#[test]
fn host_selection_first_drag_after_crossing_capacity_cannot_extend_stale_click() {
    first_drag_after_saturated_repaint(27, "M00\r\nM01\r\nM02\r\n", "M02");
}

#[test]
fn host_selection_saturated_main_cursor_only_render_keeps_static_text_copyable() {
    let initial = format!(
        "\x1b[?1002h{}\x1b[19;1H\x1b[2KSTATIC TARGET",
        numbered_lines(40)
    );
    let (mut app, mut output) = fixture(5, &initial, &["\x1b[10;12H"]);
    wait_for_text(&mut app, "STATIC TARGET");
    let backend = ratatui::backend::TestBackend::new(160, 28);
    let mut terminal = ratatui::Terminal::new(backend).expect("private host renderer");
    terminal
        .draw(|frame| app.render(frame))
        .expect("establish real host pane geometry");
    select_host_row(&mut app, "STATIC TARGET");
    assert_eq!(app.snapshot_buf.scrollback_total, 5);
    assert!(app.snapshot_selection_origin().history_saturated);
    assert!(
        !app.selected_terminal_surface_client()
            .unwrap()
            .is_alt_screen()
    );
    let origin = app.snapshot_selection_origin();
    let text_cells = |app: &App| {
        app.snapshot_buf
            .cells
            .iter()
            .map(|cell| (cell.row, cell.col, cell.symbol.to_string()))
            .collect::<Vec<_>>()
    };
    let before = text_cells(&app);
    assert!(
        !app.snapshot_buf
            .cursor
            .is_some_and(|cursor| cursor.row == 9 && cursor.col == 11),
        "the cursor-only phase must move the cursor to a different position"
    );

    output.advance();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        app.refresh_snapshot_buf();
        if app
            .snapshot_buf
            .cursor
            .is_some_and(|cursor| cursor.row == 9 && cursor.col == 11)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "private cursor move not consumed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let now = app.snapshot_selection_origin();
    assert_eq!(now.grid_size, origin.grid_size);
    assert_eq!(now.scrollback_offset, origin.scrollback_offset);
    assert_eq!(now.scrollback_total, origin.scrollback_total);
    assert_eq!(
        text_cells(&app),
        before,
        "cursor output changed no text cells"
    );

    terminal
        .draw(|frame| app.render(frame))
        .expect("real host render after cursor-only output");
    assert_eq!(text_cells(&app), before);
    assert_eq!(
        app.terminal_selection_text(),
        "STATIC TARGET",
        "cursor-only output must not make unchanged visible text impossible to copy at history capacity"
    );
}

static CAPTURED_MEMORY_COPIES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn capture_memory_copy(text: &str) -> anyhow::Result<()> {
    CAPTURED_MEMORY_COPIES
        .lock()
        .expect("in-memory clipboard lock")
        .push(text.to_string());
    Ok(())
}

#[test]
fn host_selection_cursor_only_before_first_drag_copies_static_target_to_memory() {
    let initial = format!(
        "\x1b[?1002h{}\x1b[19;1H\x1b[2KSTATIC TARGET",
        numbered_lines(40)
    );
    let (mut app, mut output) = fixture(5, &initial, &["\x1b[10;12H"]);
    // test_app itself starts only a defused worker. This replacement is also
    // entirely in-memory; Clipboard::new/arboard/OSC52 are never constructed.
    CAPTURED_MEMORY_COPIES.lock().unwrap().clear();
    app.clipboard = crate::clipboard::Clipboard::from_fn(capture_memory_copy);
    wait_for_text(&mut app, "STATIC TARGET");
    let backend = ratatui::backend::TestBackend::new(160, 28);
    let mut terminal = ratatui::Terminal::new(backend).expect("private host renderer");
    terminal
        .draw(|frame| app.render(frame))
        .expect("establish real host pane geometry");
    let row = wait_for_text(&mut app, "STATIC TARGET");
    assert!(app.snapshot_selection_origin().history_saturated);
    assert!(
        !app.selected_terminal_surface_client()
            .unwrap()
            .is_alt_screen()
    );
    let area = app.mouse_layout.agent_term.expect("rendered private pane");
    let before: Vec<_> = app
        .snapshot_buf
        .cells
        .iter()
        .map(|cell| (cell.row, cell.col, cell.symbol.to_string()))
        .collect();
    app.handle_mouse(mouse_event(
        MouseEventKind::Down(MouseButton::Left),
        area.x,
        area.y + row,
    ));

    output.advance();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        app.refresh_snapshot_buf();
        if app
            .snapshot_buf
            .cursor
            .is_some_and(|cursor| cursor.row == 9 && cursor.col == 11)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "private cursor move not consumed"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    terminal
        .draw(|frame| app.render(frame))
        .expect("real host render between press and first drag");
    let after: Vec<_> = app
        .snapshot_buf
        .cells
        .iter()
        .map(|cell| (cell.row, cell.col, cell.symbol.to_string()))
        .collect();
    assert_eq!(after, before, "cursor-only output changed no text cells");
    let end_col = area.x + "STATIC TARGET".len() as u16 - 1;
    app.handle_mouse(mouse_event(
        MouseEventKind::Drag(MouseButton::Left),
        end_col,
        area.y + row,
    ));
    app.handle_mouse(mouse_event(
        MouseEventKind::Up(MouseButton::Left),
        end_col,
        area.y + row,
    ));
    let deadline = Instant::now() + Duration::from_secs(5);
    while CAPTURED_MEMORY_COPIES.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(5));
    }
    let copied = CAPTURED_MEMORY_COPIES.lock().unwrap().clone();
    assert_eq!(
        copied,
        vec!["STATIC TARGET".to_string()],
        "the complete host drag/release must copy unchanged text despite cursor-only output between Down and first Drag"
    );
}
