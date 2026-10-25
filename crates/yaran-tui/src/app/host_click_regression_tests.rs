//! Exact host-to-private-child click wire tests. No real agent or clipboard.
use super::*;
use crate::app::test_support::{default_bindings, enter_scroll_mode, test_app};
use crossterm::event::{KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{Terminal, backend::TestBackend};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use yaran_core::ids::TabId;

// Positional paths belong to one tempdir. Commands are newline-delimited so
// a private child can emit a controlled repaint between press and release,
// while preserving every mouse-report byte separately in its wire file.
const CHILD: &str = r#"
stty raw -echo
wire=$1
ready=$2
frame=$3
flushed=$4
alt=$5
: > "$wire"
i=0
while [ "$i" -lt 200 ]; do
    printf 'private fixture row %s\r\n' "$i"
    i=$((i + 1))
done
if [ "$alt" = 1 ]; then
    printf '\033[?1049hPRIVATE ALT CARD\r\n'
fi
printf '\033[?1000h\033[?1006h'
: > "$ready"
while IFS= read -r packet; do
    case "$packet" in
        *CURSOR)
            printf '%s' "${packet%CURSOR}" >> "$wire"
            printf '\033[2;2H'
            : > "$frame"
            ;;
        *OUTPUT)
            printf '%s' "${packet%OUTPUT}" >> "$wire"
            printf '\r\nprivate output during held click\r\n'
            : > "$frame"
            ;;
        *FLUSH)
            printf '%s' "${packet%FLUSH}" >> "$wire"
            : > "$flushed"
            ;;
        *) printf '%s' "$packet" >> "$wire" ;;
    esac
done
"#;

struct ClickFixture {
    app: App,
    terminal: Terminal<TestBackend>,
    _dir: TempDir,
    wire: PathBuf,
    frame: PathBuf,
    flushed: PathBuf,
    point: (u16, u16),
    fullscreen: bool,
}

fn wait_until(mut predicate: impl FnMut() -> bool, message: &str) {
    let deadline = Instant::now() + Duration::from_secs(4);
    while !predicate() {
        assert!(Instant::now() < deadline, "{message}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

impl ClickFixture {
    fn new(capacity: usize, alt: bool, fullscreen: bool, forward: bool) -> Self {
        let mut app = test_app(default_bindings());
        app.engine.sessions[0].provider = ProviderKind::from_str("jcode");
        app.engine
            .config
            .providers
            .commands
            .get_mut("jcode")
            .unwrap()
            .forward_mouse = Some(forward);
        let dir = tempfile::tempdir().unwrap();
        let wire = dir.path().join("wire");
        let ready = dir.path().join("ready");
        let frame = dir.path().join("frame");
        let flushed = dir.path().join("flushed");
        let args = vec![
            "-c".into(),
            CHILD.into(),
            "private-click-fixture".into(),
            wire.to_string_lossy().into_owned(),
            ready.to_string_lossy().into_owned(),
            frame.to_string_lossy().into_owned(),
            flushed.to_string_lossy().into_owned(),
            if alt { "1" } else { "0" }.into(),
        ];
        let client = PtyClient::spawn("/bin/sh", &args, dir.path(), 40, 120, capacity).unwrap();
        let tab = app.engine.sessions[0].slot_tab_id().to_string();
        app.engine.providers.insert(TabId::new(tab), client);
        app.selected_left = 1;
        app.session_surface = SessionSurface::Agent;
        app.center_mode = CenterMode::Agent;
        app.focus = FocusPane::Center;
        app.input_target = if fullscreen {
            InputTarget::Agent
        } else {
            InputTarget::None
        };
        app.fullscreen_overlay = if fullscreen {
            FullscreenOverlay::Agent
        } else {
            FullscreenOverlay::None
        };
        wait_until(
            || {
                ready.exists()
                    && app
                        .selected_terminal_surface_client()
                        .unwrap()
                        .has_mouse_mode()
            },
            "private child did not initialize capture",
        );
        let mut terminal = Terminal::new(TestBackend::new(120, 40)).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let area = app
            .mouse_layout
            .agent_term
            .expect("rendered terminal target");
        assert!(area.width > 4 && area.height > 3, "{area:?}");
        assert!(!app.scroll_mode_active());
        assert_eq!(app.selected_surface_forwards_mouse(), forward);
        Self {
            app,
            terminal,
            _dir: dir,
            wire,
            frame,
            flushed,
            point: (area.x + 3, area.y + 2),
            fullscreen,
        }
    }

    fn pointer(&mut self, down: bool) {
        let (column, row) = self.point;
        if self.fullscreen {
            let final_byte = if down { 'M' } else { 'm' };
            let raw = format!("\x1b[<0;{};{}{final_byte}", column + 1, row + 1);
            self.app.process_raw_input_bytes(raw.as_bytes()).unwrap();
        } else {
            self.app.handle_mouse(MouseEvent {
                kind: if down {
                    MouseEventKind::Down(MouseButton::Left)
                } else {
                    MouseEventKind::Up(MouseButton::Left)
                },
                column,
                row,
                modifiers: KeyModifiers::NONE,
            });
        }
    }

    fn repaint(&mut self, command: Option<&str>) {
        if let Some(command) = command {
            if self.frame.exists() {
                std::fs::remove_file(&self.frame).unwrap();
            }
            if command == "CURSOR" {
                assert!(
                    !self
                        .app
                        .snapshot_buf
                        .cursor
                        .is_some_and(|cursor| { cursor.row == 1 && cursor.col == 1 }),
                    "cursor fixture already at commanded destination"
                );
            }
            self.app
                .selected_terminal_surface_client()
                .unwrap()
                .write_bytes(format!("{command}\n").as_bytes())
                .unwrap();
            wait_until(
                || {
                    self.app.refresh_snapshot_buf();
                    let effect_arrived = match command {
                        "CURSOR" => self
                            .app
                            .snapshot_buf
                            .cursor
                            .is_some_and(|cursor| cursor.row == 1 && cursor.col == 1),
                        "OUTPUT" => self
                            .app
                            .snapshot_buf
                            .cells
                            .iter()
                            .map(|cell| cell.symbol.as_str())
                            .collect::<String>()
                            .contains("private output during held click"),
                        _ => panic!("unsupported private repaint command"),
                    };
                    self.frame.exists() && effect_arrived
                },
                "controlled child repaint did not arrive",
            );
        }
        // Exercise the production render retirement, not a copied predicate.
        self.terminal.draw(|frame| self.app.render(frame)).unwrap();
    }

    fn drag(&mut self, column_delta: u16) {
        let (column, row) = self.point;
        if self.fullscreen {
            let raw = format!("\x1b[<32;{};{}M", column + column_delta + 1, row + 1);
            self.app.process_raw_input_bytes(raw.as_bytes()).unwrap();
        } else {
            self.app.handle_mouse(MouseEvent {
                kind: MouseEventKind::Drag(MouseButton::Left),
                column: column + column_delta,
                row,
                modifiers: KeyModifiers::NONE,
            });
        }
    }

    fn assert_wire(&mut self, expected: &[u8]) {
        self.app
            .selected_terminal_surface_client()
            .unwrap()
            .write_bytes(b"FLUSH\n")
            .unwrap();
        wait_until(
            || self.flushed.exists(),
            "private child did not flush click bytes",
        );
        let actual = std::fs::read(&self.wire).unwrap();
        assert_eq!(
            actual,
            expected,
            "unexpected click wire: fullscreen={}, origin={:?}, generation={}, selection={:?}",
            self.fullscreen,
            self.app.snapshot_selection_origin(),
            self.app.grid_generation,
            self.app.terminal_selection
        );
    }

    fn assert_click_wire(&mut self) {
        self.assert_wire(b"\x1b[<0;4;3M\x1b[<0;4;3m");
    }

    fn assert_no_copy(&mut self) {
        // The fixture clipboard is a no-op worker. Its FIFO completion is a
        // deterministic barrier for any earlier release-generated copy request.
        const BARRIER: &str = "private click no-copy barrier";
        self.app
            .clipboard
            .copy_text(BARRIER, BARRIER, &self.app.engine.worker_tx)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let event = self
                .app
                .engine
                .worker_rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("private clipboard barrier did not complete");
            if let WorkerEvent::ClipboardCopyCompleted { label, .. } = event {
                assert_eq!(
                    label, BARRIER,
                    "retired click carrier requested a text copy"
                );
                break;
            }
        }
    }
}

fn stationary_click_case(
    capacity: usize,
    alt: bool,
    fullscreen: bool,
    forward: bool,
    repaint: Option<&str>,
) {
    let mut fixture = ClickFixture::new(capacity, alt, fullscreen, forward);
    if !alt {
        assert_eq!(
            fixture.app.snapshot_selection_origin().history_saturated,
            capacity == 8
        );
    }
    fixture.pointer(true);
    fixture.repaint(repaint);
    fixture.pointer(false);
    fixture.assert_click_wire();
}

#[test]
fn windowed_stationary_click_survives_saturated_history_output() {
    stationary_click_case(8, false, false, false, Some("OUTPUT"));
}

#[test]
fn fullscreen_stationary_click_survives_saturated_history_output() {
    stationary_click_case(8, false, true, false, Some("OUTPUT"));
}

#[test]
fn saturated_history_cursor_only_repaint_preserves_stationary_click() {
    stationary_click_case(8, false, false, false, Some("CURSOR"));
}

#[test]
fn below_capacity_output_preserves_stationary_click() {
    stationary_click_case(1000, false, false, false, Some("OUTPUT"));
}

#[test]
fn alternate_screen_after_saturated_primary_preserves_stationary_click() {
    stationary_click_case(8, true, false, false, Some("CURSOR"));
}

#[test]
fn idle_periodic_render_preserves_saturated_history_stationary_click() {
    stationary_click_case(8, false, false, false, None);
}

#[test]
fn direct_forwarding_preserves_stationary_click_during_saturated_repaint() {
    stationary_click_case(8, false, false, true, Some("OUTPUT"));
}

#[test]
fn same_cell_drag_jitter_preserves_stationary_click_after_drift() {
    for fullscreen in [false, true] {
        let mut fixture = ClickFixture::new(8, false, fullscreen, false);
        fixture.pointer(true);
        fixture.repaint(Some("OUTPUT"));
        fixture.drag(0);
        fixture.pointer(false);
        fixture.assert_click_wire();
        fixture.assert_no_copy();
    }
}

#[test]
fn moved_drag_after_drift_neither_replays_click_nor_copies_stale_text() {
    for fullscreen in [false, true] {
        let mut fixture = ClickFixture::new(8, false, fullscreen, false);
        fixture.pointer(true);
        fixture.repaint(Some("OUTPUT"));
        fixture.drag(1);
        assert!(
            fixture.app.terminal_selection.is_none(),
            "stale anchor survived actual movement"
        );
        // A subsequent return to the press cell must not resurrect click eligibility.
        fixture.drag(0);
        fixture.pointer(false);
        assert!(fixture.app.terminal_selection.is_none());
        fixture.assert_wire(b"");
        fixture.assert_no_copy();
    }
}

#[test]
fn scroll_mode_suppresses_stationary_click_replay() {
    for fullscreen in [false, true] {
        let mut fixture = ClickFixture::new(8, false, fullscreen, false);
        enter_scroll_mode(&mut fixture.app, 1);
        fixture.repaint(None);
        assert!(fixture.app.scroll_mode_active());
        fixture.pointer(true);
        fixture.repaint(None);
        fixture.pointer(false);
        assert!(fixture.app.scroll_mode_active());
        fixture.assert_wire(b"");
        fixture.assert_no_copy();
    }
}

#[test]
fn viewport_resize_retires_pending_stationary_click() {
    // A one-column outer resize can round to the SAME split-pane width.
    // Use unambiguous changes and verify the actual published inner target.
    for (width, height) in [(100, 40), (120, 34)] {
        let mut fixture = ClickFixture::new(8, false, false, false);
        fixture.pointer(true);
        let before = fixture.app.snapshot_selection_origin().grid_size;
        fixture.terminal.backend_mut().resize(width, height);
        fixture
            .terminal
            .resize(ratatui::layout::Rect::new(0, 0, width, height))
            .unwrap();
        fixture.repaint(None);
        let area = fixture
            .app
            .mouse_layout
            .agent_term
            .expect("resized terminal target");
        let expected = (area.height, area.width);
        assert_ne!(
            expected, before,
            "outer resize did not change the inner target"
        );
        wait_until(
            || {
                fixture.app.refresh_snapshot_buf();
                fixture.app.snapshot_selection_origin().grid_size == expected
            },
            "private PTY snapshot did not adopt resized inner dimensions",
        );
        fixture.repaint(None);
        assert_ne!(fixture.app.snapshot_selection_origin().grid_size, before);
        assert!(fixture.app.terminal_selection.is_none());
        fixture.pointer(false);
        fixture.assert_wire(b"");
        fixture.assert_no_copy();
    }
}

#[test]
fn switching_surface_and_back_retires_pending_stationary_click() {
    let mut fixture = ClickFixture::new(8, false, false, false);
    let mut other = ClickFixture::new(8, false, false, false);
    let other_slot = other.app.engine.sessions[0].slot_tab_id().to_string();
    let other_client = other
        .app
        .engine
        .providers
        .remove(TabIdRef::new(&other_slot))
        .unwrap();
    let original_slot = fixture.app.engine.sessions[0].slot_tab_id().to_string();
    let other_id = format!("{original_slot}-private-other");
    fixture
        .app
        .engine
        .providers
        .insert(TabId::new(other_id.clone()), other_client);
    fixture.pointer(true);
    fixture.app.engine.sessions[0].slot_tab_id = other_id;
    fixture.repaint(None);
    assert!(fixture.app.terminal_selection.is_none());
    fixture.app.engine.sessions[0].slot_tab_id = original_slot;
    fixture.repaint(None);
    fixture.pointer(false);
    fixture.assert_wire(b"");
    fixture.assert_no_copy();
}
