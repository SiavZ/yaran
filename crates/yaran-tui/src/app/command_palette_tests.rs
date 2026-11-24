//! Navigation and rendering checks for the categorized palette.

use super::*;
use crate::app::OverlayMouseLayout;
use crate::app::test_support::{default_bindings, finish_ui_jobs, test_app};
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use ratatui::{Terminal, backend::TestBackend};

fn names(app: &App, query: &str) -> Vec<&'static str> {
    app.palette_entries(query)
        .into_iter()
        .map(PaletteEntry::name)
        .collect()
}

fn choose(app: &mut App, name: &str) {
    let index = names(app, "")
        .iter()
        .position(|&row| row == name)
        .expect("row exists");
    app.set_command_palette_selection(index);
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .expect("choose row");
}

#[test]
fn ctrl_p_opens_only_categories_and_every_command_has_one_home() {
    let mut app = test_app(default_bindings());
    app.handle_key(KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL))
        .expect("open palette");
    assert_eq!(
        names(&app, ""),
        vec![
            "Agents",
            "Projects",
            "Terminals",
            "Git & files",
            "View & appearance",
            "Input & macros",
            "Connections",
            "Tools & configuration",
        ]
    );
    assert!(
        app.palette_entries("")
            .iter()
            .all(|entry| matches!(entry, PaletteEntry::Category(_)))
    );
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).expect("terminal");
    terminal
        .draw(|frame| app.render(frame))
        .expect("render root");
    assert!(matches!(
        app.overlay_layout.active,
        OverlayMouseLayout::Command { items: 8, .. }
    ));
    for command in yaran_core::palette::PALETTE_COMMANDS {
        assert!(
            PaletteCategory::for_action(command.action).is_some(),
            "{} has no category",
            command.name
        );
        if app.is_palette_action_available(command.action) {
            assert!(
                names(&app, command.name).contains(&command.name),
                "{} cannot be searched",
                command.name
            );
        }
    }
    let expected: std::collections::HashSet<_> = app
        .filtered_palette_commands("")
        .iter()
        .filter_map(|binding| binding.palette_name)
        .collect();
    let mut browsed = std::collections::HashSet::new();
    for category in PaletteCategory::ROOTS {
        app.navigate_palette_category(Some(category));
        for entry in app.palette_entries("") {
            assert!(
                !matches!(entry, PaletteEntry::Category(_)),
                "categories must contain commands directly"
            );
            if let PaletteEntry::Command(binding) = entry {
                assert_eq!(PaletteCategory::for_action(binding.action), Some(category));
                assert!(browsed.insert(entry.name()), "command appears twice");
            }
        }
        assert_eq!(names(&app, "").last(), Some(&"Back"));
    }
    assert_eq!(browsed, expected);
    app.navigate_palette_category(None);
    choose(&mut app, "Agents");
    for command in ["new-agent", "session-settings", "change-default-provider"] {
        assert!(names(&app, "").contains(&command));
    }
    choose(&mut app, "Back");
    assert!(!names(&app, "").contains(&"Settings"));
    choose(&mut app, "Projects");
    assert!(names(&app, "").contains(&"configure-startup-command"));
    choose(&mut app, "Back");
    choose(&mut app, "View & appearance");
    assert!(names(&app, "theme").contains(&"change-theme"));
    assert_eq!(names(&app, "provider"), vec!["Back"]);
    choose(&mut app, "change-theme");
    finish_ui_jobs(&mut app);
    assert!(matches!(app.prompt, PromptState::ChangeTheme { .. }));
}

#[test]
fn palette_close_returns_to_root_then_closes() {
    let mut app = test_app(default_bindings());
    app.navigate_palette_category(Some(PaletteCategory::View));
    app.handle_key(KeyEvent::new(KeyCode::Char('i'), KeyModifiers::NONE))
        .expect("type query");
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
        .expect("back to root");
    assert!(
        matches!(&app.prompt, PromptState::Command { category: None, input, selected: 0 } if input.is_empty())
    );
    app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
        .expect("close");
    assert!(matches!(app.prompt, PromptState::None));
}

#[test]
fn palette_categories_render_and_open_with_the_mouse() {
    let mut app = test_app(default_bindings());
    app.navigate_palette_category(None);
    let mut terminal = Terminal::new(TestBackend::new(120, 40)).expect("terminal");
    let expected = PaletteCategory::View;
    terminal.draw(|frame| app.render(frame)).expect("render");
    let OverlayMouseLayout::Command { list, .. } = app.overlay_layout.active else {
        panic!("palette layout");
    };
    let index = names(&app, "")
        .iter()
        .position(|&name| name == expected.name())
        .expect("category row");
    for _ in 0..2 {
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: list.x,
            row: list.y + u16::try_from(index).expect("category index fits"),
            modifiers: KeyModifiers::NONE,
        });
    }
    assert!(
        matches!(app.prompt, PromptState::Command { category: Some(category), .. } if category == expected)
    );
    terminal
        .draw(|frame| app.render(frame))
        .expect("render breadcrumb");
    let text: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(ratatui::buffer::Cell::symbol)
        .collect();
    assert!(text.contains("Command Palette / View & appearance"));
    assert!(text.contains("change-theme"));
    assert!(!text.contains("set-tailscale-mode"));
}

#[test]
fn palette_search_can_open_a_category_and_complete_a_setting() {
    let mut app = test_app(default_bindings());
    app.navigate_palette_category(None);
    if let PromptState::Command { input, .. } = &mut app.prompt {
        input.set_text("appearance".to_string());
    }
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .expect("open category");
    assert!(matches!(
        app.prompt,
        PromptState::Command {
            category: Some(PaletteCategory::View),
            ..
        }
    ));
    if let PromptState::Command { input, .. } = &mut app.prompt {
        input.set_text("theme".to_string());
    }
    app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE))
        .expect("complete");
    assert!(
        matches!(&app.prompt, PromptState::Command { input, .. } if input.text == "change-theme")
    );
    app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
        .expect("run setting");
    finish_ui_jobs(&mut app);
    assert!(matches!(app.prompt, PromptState::ChangeTheme { .. }));
}
