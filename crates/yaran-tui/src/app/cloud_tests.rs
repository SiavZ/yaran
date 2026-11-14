//! Tests for the Yaran Cloud palette commands and their modals.
//!
//! The registry fixtures live here too, so `modal.rs`'s structural guards (family,
//! dual-mode rule, no quoted names, no split chips) cover every Cloud stage.
//!
//! - Families, Escape cancelling a running login, Space on the focused button, chips
//!   in outcome sentences, and a QR painted from the two theme tokens only.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_tests.rs
//! ├── app
//! ├── app::cloud_commands
//! ├── app::cloud_render
//! ├── app::modal
//! ├── app::test_support
//! ├── app::text_input
//! ├── theme
//! ├── yaran-core::cloud::login_session
//! ├── yaran-core::cloud::machine_api
//! ├── yaran-core::cloud::outcome
//! ├── yaran-core::cloud::qr
//! ├── yaran-core::cloud::status
//! ├── yaran-core::cloud::test_support
//! └── yaran-core::config
//! External: crossterm, ratatui, serde_json, std, tempfile
//!
//! Used by:
//! app/cloud_tests.rs
//! ├── app
//! └── app::modal
//! <module-headers:end>

use std::sync::mpsc;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::Terminal;
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use yaran_core::cloud::login_session::AuthorizeInfo;
use yaran_core::cloud::machine_api::test_api_factory;
use yaran_core::cloud::outcome::{KEY_LOGIN, KEY_ROTATE};
use yaran_core::cloud::qr::Qr;
use yaran_core::cloud::status::StatusReport;
use yaran_core::cloud::test_support::{MockResponse, MockWorker, SAMPLE_ORG};

use super::cloud_commands::{CloudLogin, CloudLoginWaiting, CloudPrompt, PhoneQr};
use super::cloud_render::qr_lines;
use super::modal::{ModalFamily, modal_spec};
use super::test_support::{default_bindings, test_app};
use super::text_input::TextInput;
use super::*;

fn sample_qr() -> PhoneQr {
    let (uri, qr) = Qr::add_org(SAMPLE_ORG).expect("qr");
    let size = qr.size();
    PhoneQr {
        org_url: SAMPLE_ORG.into(),
        uri,
        modules: (0..size)
            .map(|y| (0..size).map(|x| qr.is_dark(x, y)).collect())
            .collect(),
    }
}

/// Every Cloud stage, for `modal.rs`'s `every_prompt`.
pub(crate) fn fixtures() -> Vec<(&'static str, PromptState)> {
    let login = |waiting| {
        PromptState::Cloud(CloudPrompt::Login(Box::new(CloudLogin {
            org_url: TextInput::with_text(SAMPLE_ORG.into()),
            waiting,
        })))
    };
    vec![
        ("CloudLogin", login(None)),
        (
            "CloudLoginWaiting",
            login(Some(CloudLoginWaiting {
                org_url: SAMPLE_ORG.into(),
                authorize: Some(AuthorizeInfo {
                    // Short enough to fit the narrowest row the chip guard tries; a
                    // real authorize URL is longer and hard-breaks, like any name
                    // wider than its row.
                    url: "https://cloud.example.com/a".into(),
                    fingerprint: "WXYZ-1234".into(),
                    org_name: "Example Org".into(),
                    machine_name: "laptop".into(),
                }),
                paste: TextInput::new(),
                note: Some("That address is not this login's callback.".into()),
            })),
        ),
        (
            "CloudLogout",
            PromptState::Cloud(CloudPrompt::Logout(ConfirmFocus::Cancel)),
        ),
        (
            "CloudRotate",
            PromptState::Cloud(CloudPrompt::Rotate(ConfirmFocus::Cancel)),
        ),
        ("CloudStatus", PromptState::Cloud(CloudPrompt::Status(None))),
        (
            "CloudStatusNotPaired",
            PromptState::Cloud(CloudPrompt::Status(Some(Box::new(not_paired())))),
        ),
        (
            "CloudPairPhone",
            PromptState::Cloud(CloudPrompt::PairPhone(Some(Ok(sample_qr())))),
        ),
    ]
}

fn not_paired() -> StatusReport {
    StatusReport {
        mode: "auto".into(),
        ..StatusReport::default()
    }
}

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn paint(app: &mut App) -> ratatui::buffer::Buffer {
    let mut terminal = Terminal::new(TestBackend::new(160, 60)).expect("terminal");
    terminal.draw(|frame| app.render(frame)).expect("render");
    terminal.backend().buffer().clone()
}

fn status_for(app: &App, key: &str) -> Option<String> {
    app.status
        .snapshot()
        .into_iter()
        .find(|s| s.key.as_deref() == Some(key))
        .map(|s| s.message)
}

fn drain_until(app: &mut App, done: impl Fn(&App) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done(app) {
        assert!(
            Instant::now() < deadline,
            "timed out waiting on a cloud worker"
        );
        app.drain_cloud();
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn each_cloud_modal_declares_its_family() {
    let family = |name: &str| {
        let (_, prompt) = fixtures().into_iter().find(|(n, _)| *n == name).unwrap();
        modal_spec(&prompt).map(|spec| spec.family)
    };
    assert_eq!(family("CloudLogin"), Some(ModalFamily::Form));
    assert_eq!(family("CloudLoginWaiting"), Some(ModalFamily::Form));
    assert_eq!(family("CloudLogout"), Some(ModalFamily::Confirm));
    assert_eq!(family("CloudRotate"), Some(ModalFamily::Confirm));
    assert_eq!(family("CloudStatus"), Some(ModalFamily::Report));
    assert_eq!(family("CloudPairPhone"), Some(ModalFamily::Report));
}

#[test]
fn each_palette_command_opens_its_modal() {
    let mut app = test_app(default_bindings());
    app.engine.config.cloud.org_url = SAMPLE_ORG.into();
    app.execute_command("cloud-login".into()).unwrap();
    let PromptState::Cloud(CloudPrompt::Login(login)) = &app.prompt else {
        panic!("{:?}", app.prompt);
    };
    assert_eq!(
        login.org_url.text, SAMPLE_ORG,
        "pre-filled from [cloud] org_url"
    );
    for (name, rotate) in [("cloud-logout", false), ("cloud-rotate-token", true)] {
        app.execute_command(name.into()).unwrap();
        match &app.prompt {
            PromptState::Cloud(CloudPrompt::Logout(ConfirmFocus::Cancel)) if !rotate => {}
            PromptState::Cloud(CloudPrompt::Rotate(ConfirmFocus::Cancel)) if rotate => {}
            other => panic!("{name}: {other:?}"),
        }
    }
    app.execute_command("cloud-status".into()).unwrap();
    drain_until(&mut app, |app| {
        matches!(app.prompt, PromptState::Cloud(CloudPrompt::Status(Some(_))))
    });
    app.execute_command("cloud-pair-phone".into()).unwrap();
    drain_until(&mut app, |app| {
        matches!(
            app.prompt,
            PromptState::Cloud(CloudPrompt::PairPhone(Some(Ok(_))))
        )
    });
}

#[test]
fn escape_cancels_a_running_login_and_closes_its_listener() {
    let worker = MockWorker::start(|_| {
        MockResponse::json(
            200,
            serde_json::json!({
                "service": "yaran-cloud", "protocol": {"min": 1, "max": 1}, "setup": "closed",
                "org": {"name": "Example Org", "url": SAMPLE_ORG},
                "access": {"team_domain": "team.cloudflareaccess.com"}, "worker": {"version": "1.0.0"},
                "capabilities": [], "push": {"enabled": false, "vapid_public_key": null}
            }),
        )
    });
    let mut app = test_app(default_bindings());
    app.cloud.api = Some(test_api_factory(worker.base_url()));
    let (opened_tx, opened_rx) = mpsc::channel();
    app.url_opener = Arc::new(move |url: &str| {
        let _ = opened_tx.send(url.to_string());
        Ok(())
    });
    app.engine.config.cloud.org_url = SAMPLE_ORG.into();
    app.execute_command("cloud-login".into()).unwrap();
    app.handle_key(key(KeyCode::Enter)).unwrap();
    assert!(
        status_for(&app, KEY_LOGIN).is_some(),
        "a keyed busy shows at once"
    );
    drain_until(&mut app, |app| {
        matches!(&app.prompt, PromptState::Cloud(CloudPrompt::Login(login))
            if login.waiting.as_ref().is_some_and(|w| w.authorize.is_some()))
    });
    let opened = opened_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("opened");
    assert!(opened.contains("/v1/pair/authorize?"), "{opened}");

    let handle = app.cloud.login.clone().expect("running");
    app.handle_key(key(KeyCode::Esc)).unwrap();
    assert!(handle.is_cancelled(), "Escape cancels the login");
    assert!(matches!(app.prompt, PromptState::None));
    drain_until(&mut app, |app| app.cloud.login.is_none());
    let said = status_for(&app, KEY_LOGIN).expect("the cancel is said");
    assert!(said.contains("cancelled"), "{said}");
}

#[test]
fn space_activates_the_focused_button() {
    let mut app = test_app(default_bindings());
    // Cancel has focus: Space closes and runs nothing.
    app.execute_command("cloud-logout".into()).unwrap();
    app.handle_key(key(KeyCode::Char(' '))).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    assert!(app.status.snapshot().iter().all(|s| s.key.is_none()));

    // Focus moved onto Rotate token: Space runs it, and the worker answers.
    app.execute_command("cloud-rotate-token".into()).unwrap();
    app.handle_key(key(KeyCode::Tab)).unwrap();
    assert!(matches!(
        app.prompt,
        PromptState::Cloud(CloudPrompt::Rotate(ConfirmFocus::Confirm))
    ));
    app.handle_key(key(KeyCode::Char(' '))).unwrap();
    assert!(matches!(app.prompt, PromptState::None));
    drain_until(&mut app, |app| {
        status_for(app, KEY_ROTATE).is_some_and(|m| m.contains("not paired"))
    });
}

#[test]
fn outcome_sentences_render_as_chips() {
    let mut app = test_app(default_bindings());
    app.prompt = PromptState::Cloud(CloudPrompt::Status(Some(Box::new(not_paired()))));
    let buf = paint(&mut app);
    let chip = app.theme.name_style();
    let name = " yaran cloud login ";
    let width = buf.area.width;
    let found = (0..buf.area.height).find_map(|y| {
        let row: String = (0..width).map(|x| buf[(x, y)].symbol()).collect();
        row.find(name)
            .map(|at| (row[..at].chars().count() as u16, y))
    });
    let (x, y) = found.expect("the NotPaired sentence names the command");
    for dx in 0..name.len() as u16 {
        let cell = &buf[(x + dx, y)];
        assert_eq!(
            (Some(cell.fg), Some(cell.bg)),
            (chip.fg, chip.bg),
            "cell {dx}"
        );
    }
}

#[test]
fn the_qr_painter_uses_only_the_two_theme_tokens() {
    let mut app = test_app(default_bindings());
    let (dark, light) = (Color::Rgb(1, 2, 3), Color::Rgb(250, 251, 252));
    app.theme.qr_dark = dark;
    app.theme.qr_light = light;
    let qr = sample_qr();
    let size = qr.modules.len();
    let lines = qr_lines(size, |x, y| qr.modules[y][x], &app.theme);
    assert_eq!(
        lines.len(),
        size.div_ceil(2),
        "two module rows per cell row"
    );
    for line in &lines {
        assert_eq!(line.spans.len(), size);
        for span in &line.spans {
            assert_eq!(span.content, "\u{2580}");
            assert!([Some(dark), Some(light)].contains(&span.style.fg));
            assert!([Some(dark), Some(light)].contains(&span.style.bg));
        }
    }
    // The quiet zone is light; the finder pattern's corner (4, 4) is dark.
    assert_eq!(lines[0].spans[0].style.fg, Some(light));
    assert_eq!(lines[2].spans[4].style.fg, Some(dark));

    // Painted in the modal, every half-block cell carries only those two colors.
    app.prompt = PromptState::Cloud(CloudPrompt::PairPhone(Some(Ok(qr))));
    let buf = paint(&mut app);
    let blocks: Vec<_> = buf
        .content()
        .iter()
        .filter(|c| c.symbol() == "\u{2580}")
        .collect();
    assert_eq!(blocks.len(), size * size.div_ceil(2));
    assert!(
        blocks
            .iter()
            .all(|c| [dark, light].contains(&c.fg) && [dark, light].contains(&c.bg))
    );
}

#[test]
fn every_loadable_theme_paints_the_qr_black_on_white() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path().to_path_buf();
    let paths = yaran_core::config::YaranPaths {
        config_path: root.join("config.toml"),
        sessions_db_path: root.join("sessions.sqlite3"),
        worktrees_root: root.join("worktrees"),
        lock_path: root.join("yaran.lock"),
        root,
    };
    for listing in crate::theme::discover_available(&paths) {
        let theme = crate::theme::load(&listing.id, &paths).expect("theme");
        assert_eq!(
            (theme.qr_dark, theme.qr_light),
            (Color::Black, Color::White),
            "{}",
            listing.id
        );
    }
}
