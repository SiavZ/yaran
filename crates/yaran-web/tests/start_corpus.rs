//! `yaran server`'s start against the start corpus: for every case, it starts
//! exactly when the release before the config checks were rebuilt did (or as
//! the corpus says it changed on purpose), with no `--bind` or `--port`, and
//! the one list of start checks agrees with it.

#[test]
fn yaran_server_starts_exactly_as_the_start_corpus_says() {
    let mut wrong = Vec::new();
    for case in yaran_core::start_check_fixtures::start_corpus() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let paths = yaran_core::config::YaranPaths {
            root: root.to_path_buf(),
            config_path: root.join("config.toml"),
            sessions_db_path: root.join("sessions.sqlite3"),
            worktrees_root: root.join("worktrees"),
            lock_path: root.join("dux.lock"),
            socket_path: root.join("yaran.sock"),
        };
        std::fs::write(&paths.config_path, &case.text).expect("seed");
        // As `yaran server` starts: the config read, the listener plan with no
        // command-line overrides, then the engine.
        let starts = match yaran_core::config::load_config(&paths) {
            Err(_) => false,
            Ok(config) => {
                yaran_core::config::resolve_server_plan(
                    &config.server,
                    &yaran_core::config::ServerCliOverrides::default(),
                    None,
                )
                .is_ok()
                    && yaran_web::bootstrap::bootstrap_engine(&paths).is_ok()
            }
        };
        let listed = yaran_core::config::start_problems_of(&case.text)
            .iter()
            .all(|problem| !problem.stops(yaran_core::config::Surface::YaranServer));
        if starts != case.yaran_server_starts || listed != case.yaran_server_starts {
            wrong.push(format!(
                "{:?}: starts {starts}, the list says {listed}, the corpus says {}",
                case.text, case.yaran_server_starts
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
