//! The reload protocol must reach the TUI without starting a terminal in tests.

use clap::{CommandFactory, Parser};

use crate::commands::Cli;
use yaran_core::reload_handoff::HANDOFF_FLAG;

#[test]
fn reload_handoff_selects_the_tui_instead_of_a_client_command() {
    let cli = Cli::try_parse_from(["yaran", HANDOFF_FLAG, "handoff.json"])
        .expect("the running TUI's reload command must parse");
    assert!(cli.command.is_none());
    assert_eq!(
        cli.reload_handoff.as_deref(),
        Some(std::path::Path::new("handoff.json"))
    );

    let args = vec![HANDOFF_FLAG.to_string(), "handoff.json".to_string()];
    assert_eq!(
        yaran_core::reload_policy::handoff_path_from_args(&args).as_deref(),
        Some(std::path::Path::new("handoff.json"))
    );
}

#[test]
fn the_internal_reload_flag_is_hidden_and_cannot_select_a_remote_client() {
    assert!(
        Cli::try_parse_from(["yaran", HANDOFF_FLAG, "handoff.json", "--remote", "box"]).is_err()
    );
    assert!(
        !Cli::command()
            .render_long_help()
            .to_string()
            .contains(HANDOFF_FLAG)
    );
}
