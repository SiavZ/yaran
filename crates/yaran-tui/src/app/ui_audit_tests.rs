use super::test_support::{default_bindings, test_app};
use super::*;

fn configure_prompt(app: &App, startup: bool) -> PromptState {
    let project = &app.engine.projects[0];
    let input = TextInput::with_text("AUDIT_DRAFT=keep".to_string()).with_multiline(8);
    if startup {
        PromptState::ConfigureStartupCommand {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            input,
            focus: ConfigureFieldFocus::Save,
        }
    } else {
        PromptState::ConfigureProjectEnv {
            project_id: project.id.clone(),
            project_name: project.name.clone(),
            input,
            focus: ConfigureFieldFocus::Save,
        }
    }
}

fn draft(app: &App) -> Option<&str> {
    match &app.prompt {
        PromptState::ConfigureStartupCommand { input, .. }
        | PromptState::ConfigureProjectEnv { input, .. }
        | PromptState::ConfigureGlobalEnv { input, .. } => Some(&input.text),
        _ => None,
    }
}

fn finish_persistence(app: &mut App) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !app.pending_persist_ops.is_empty() && Instant::now() < deadline {
        app.drain_events();
        thread::sleep(Duration::from_millis(10));
    }
    assert!(
        app.pending_persist_ops.is_empty(),
        "persistence must finish"
    );
}

#[test]
fn global_environment_failed_save_keeps_the_draft_for_retry() {
    let mut app = test_app(default_bindings());
    let tmp = tempfile::tempdir().unwrap();
    let blocked = tmp.path().join("blocked");
    std::fs::create_dir(&blocked).unwrap();
    app.engine.config_writer = yaran_core::config_queue::ConfigWriteQueue::new(blocked);
    let previous = app.engine.config.env.clone();
    app.prompt = PromptState::ConfigureGlobalEnv {
        project_name: "All projects".into(),
        input: TextInput::with_text("AUDIT_DRAFT=keep".into()).with_multiline(8),
        focus: ConfigureFieldFocus::Save,
    };

    app.apply_configure_global_env().unwrap();

    assert_eq!(draft(&app), Some("AUDIT_DRAFT=keep"));
    assert_eq!(app.engine.config.env, previous);
    assert_eq!(app.status.tone(), StatusTone::Error);
    app.engine.config_writer =
        yaran_core::config_queue::ConfigWriteQueue::new(tmp.path().join("config.toml"));
    app.apply_configure_global_env().unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    assert_eq!(
        app.engine.config.env.get("AUDIT_DRAFT").map(String::as_str),
        Some("keep")
    );
}

#[test]
fn global_environment_save_during_reload_keeps_the_draft_without_queuing_it() {
    let mut app = test_app(default_bindings());
    let previous = app.engine.config.env.clone();
    app.engine.reloading = true;
    app.prompt = PromptState::ConfigureGlobalEnv {
        project_name: "All projects".into(),
        input: TextInput::with_text("AUDIT_DRAFT=keep".into()).with_multiline(8),
        focus: ConfigureFieldFocus::Save,
    };

    app.apply_configure_global_env().unwrap();

    assert_eq!(draft(&app), Some("AUDIT_DRAFT=keep"));
    assert_eq!(app.engine.config.env, previous);
    assert!(
        app.engine.deferred_commands.is_empty(),
        "dismissed drafts must not be saved later by a reload"
    );
}

#[test]
fn project_configuration_waits_for_persistence_and_keeps_failed_drafts() {
    for startup in [false, true] {
        let mut app = test_app(default_bindings());
        let tmp = tempfile::tempdir().unwrap();
        let blocked = tmp.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        app.engine.config_writer = yaran_core::config_queue::ConfigWriteQueue::new(blocked);
        app.prompt = configure_prompt(&app, startup);

        app.apply_configure_modal().unwrap();
        assert_eq!(draft(&app), Some("AUDIT_DRAFT=keep"));
        app.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE))
            .unwrap();
        app.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE))
            .unwrap();
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let OverlayMouseLayout::ConfigureStartupCommand {
            cancel_button,
            input,
            ..
        } = app.overlay_layout.active
        else {
            panic!("configure controls must remain painted while saving");
        };
        for area in [cancel_button, input] {
            for kind in [
                MouseEventKind::Down(MouseButton::Left),
                MouseEventKind::Up(MouseButton::Left),
            ] {
                app.handle_mouse(MouseEvent {
                    kind,
                    column: area.x,
                    row: area.y,
                    modifiers: KeyModifiers::NONE,
                });
            }
        }
        assert_eq!(
            app.input_target,
            InputTarget::None,
            "pending save must not reengage the field"
        );
        assert_eq!(
            app.pending_persist_ops.len(),
            1,
            "pending save must not close or submit again"
        );
        finish_persistence(&mut app);
        assert_eq!(draft(&app), Some("AUDIT_DRAFT=keep"));
        assert_eq!(app.status.tone(), StatusTone::Error);

        app.engine.config_writer =
            yaran_core::config_queue::ConfigWriteQueue::new(tmp.path().join("config.toml"));
        app.apply_configure_modal().unwrap();
        finish_persistence(&mut app);
        assert!(
            matches!(app.prompt, PromptState::None),
            "successful retry closes the form"
        );
    }
}

#[test]
fn project_configuration_database_failure_keeps_the_draft_and_allows_retry() {
    for startup in [false, true] {
        let mut app = test_app(default_bindings());
        let db = rusqlite::Connection::open(&app.engine.paths.sessions_db_path).unwrap();
        db.execute_batch("CREATE TRIGGER reject_audit_update BEFORE UPDATE ON projects BEGIN SELECT RAISE(FAIL, 'audit database refusal'); END;").unwrap();
        app.prompt = configure_prompt(&app, startup);

        app.apply_configure_modal().unwrap();
        finish_persistence(&mut app);

        assert_eq!(draft(&app), Some("AUDIT_DRAFT=keep"));
        assert!(app.configure_save_op.is_none());
        assert_eq!(app.status.tone(), StatusTone::Error);
        assert!(app.status.message().contains("audit database refusal"));
        assert!(app.engine.projects[0].env.is_empty());
        assert!(app.engine.projects[0].startup_command.is_none());

        db.execute_batch("DROP TRIGGER reject_audit_update;")
            .unwrap();
        app.apply_configure_modal().unwrap();
        finish_persistence(&mut app);
        assert!(matches!(app.prompt, PromptState::None));
        let project = &app.engine.projects[0];
        if startup {
            assert_eq!(project.startup_command.as_deref(), Some("AUDIT_DRAFT=keep"));
        } else {
            assert_eq!(
                project.env.get("AUDIT_DRAFT").map(String::as_str),
                Some("keep")
            );
        }
    }
}

#[test]
fn a_completed_configuration_save_does_not_close_a_replacement_modal() {
    let mut app = test_app(default_bindings());
    app.prompt = configure_prompt(&app, false);
    app.apply_configure_modal().unwrap();
    app.prompt = PromptState::Command {
        input: TextInput::with_text("new-agent".into()),
        selected: 0,
    };

    finish_persistence(&mut app);

    assert!(app.configure_save_op.is_none());
    assert!(matches!(&app.prompt, PromptState::Command { input, .. } if input.text == "new-agent"));
}

#[test]
fn a_completed_configuration_save_does_not_close_another_projects_draft() {
    for startup in [false, true] {
        let mut app = test_app(default_bindings());
        app.prompt = configure_prompt(&app, startup);
        app.apply_configure_modal().unwrap();
        app.prompt = configure_prompt(&app, startup);
        match &mut app.prompt {
            PromptState::ConfigureStartupCommand {
                project_id, input, ..
            }
            | PromptState::ConfigureProjectEnv {
                project_id, input, ..
            } => {
                *project_id = "another-project".into();
                *input = TextInput::with_text("NEW_DRAFT=leave".into()).with_multiline(8);
            }
            _ => unreachable!(),
        }

        finish_persistence(&mut app);

        assert!(app.configure_save_op.is_none());
        assert_eq!(draft(&app), Some("NEW_DRAFT=leave"));
    }
}

#[test]
fn tall_forms_leave_the_complete_status_footer_visible() {
    use ratatui::{Terminal, backend::TestBackend};
    for macros in [false, true] {
        let mut app = test_app(default_bindings());
        if macros {
            app.execute_command("edit-macros".into()).unwrap();
        } else {
            app.prompt = configure_prompt(&app, false);
        }
        app.set_error("Could not save project environment variables: the second line is invalid; use KEY=value syntax and retry.");
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| app.render(frame)).unwrap();
        let footer: String = terminal.backend().buffer().content()[22 * 80..]
            .iter()
            .map(|cell| cell.symbol())
            .collect();
        assert!(
            footer.contains("Could not save project environment variables"),
            "{footer}"
        );
        assert!(
            footer.contains("use KEY=value syntax and retry."),
            "{footer}"
        );
    }
}

#[test]
fn narrow_changed_file_rows_keep_stats_for_selected_and_wide_paths() {
    use ratatui::{Terminal, backend::TestBackend};
    let mut app = test_app(default_bindings());
    app.focus = FocusPane::Files;
    app.right_section = RightSection::Unstaged;
    app.engine.unstaged_files = [
        "src/a-very-long-selected-file-name.rs",
        "src/長い名前の変更ファイル.rs",
    ]
    .into_iter()
    .map(|path| ChangedFile {
        status: "M".into(),
        path: path.into(),
        additions: 123,
        deletions: 45,
        binary: false,
        diff_excluded: false,
        renamed_from: None,
    })
    .collect();
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    terminal.draw(|frame| app.render(frame)).unwrap();
    let screen: String = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert_eq!(screen.matches("+123 -45").count(), 2, "{screen}");
    let header = terminal
        .backend()
        .buffer()
        .content()
        .chunks(80)
        .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
        .find_map(|row| row.find("Changes (2)").map(|at| row[at..].to_string()))
        .expect("the file count stays visible");
    assert!(
        !header.contains('+') && !header.contains('-'),
        "a summary that cannot fit must not show partial totals: {header}"
    );
    let selected: Vec<_> = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .filter(|cell| cell.bg == app.theme.selection_bg && !cell.symbol().trim().is_empty())
        .collect();
    assert!(selected.iter().any(|cell| cell.symbol() == "+"));
    assert!(selected.iter().any(|cell| cell.symbol() == "M"));
    assert!(
        selected
            .iter()
            .all(|cell| cell.fg == app.theme.selection_fg)
    );
}
