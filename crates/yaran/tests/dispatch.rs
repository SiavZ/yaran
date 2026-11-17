//! Runs the built `yaran` binary through its real command dispatch. Every run
//! gets its own empty `YARAN_HOME`, so nothing here touches a real config folder,
//! and `stdin` is closed so a command that wrongly fell through to the terminal
//! UI fails instead of waiting for a keyboard.

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

struct Run {
    out: Output,
}

impl Run {
    fn code(&self) -> i32 {
        self.out.status.code().expect("exited normally")
    }
    fn stdout(&self) -> String {
        String::from_utf8_lossy(&self.out.stdout).into_owned()
    }
    fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.out.stderr).into_owned()
    }
}

fn home(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("yaran-dispatch-{}-{test}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("make the config folder");
    dir
}

fn yaran(test: &str, args: &[&str]) -> Run {
    yaran_in(&home(test), args, &[])
}

/// Run yaran on `dir` as it stands, with `env` set and no remote override from
/// the shell running the tests.
fn yaran_in(dir: &std::path::Path, args: &[&str], env: &[(&str, &str)]) -> Run {
    let out = Command::new(env!("CARGO_BIN_EXE_yaran"))
        .args(args)
        .env("YARAN_HOME", dir)
        .env_remove("YARAN_REMOTE")
        .env_remove("DUX_REMOTE")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .output()
        .expect("the yaran binary runs");
    Run { out }
}

#[test]
fn version_prints_the_version_and_exits_zero() {
    let run = yaran("version", &["--version"]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    // The display version and the commit, so two development builds tell apart.
    assert_eq!(
        run.stdout().trim(),
        format!("yaran {}", yaran_core::version::long())
    );
}

#[test]
fn an_unknown_top_level_command_is_a_usage_error() {
    let run = yaran("unknown", &["frobnicate"]);
    assert_eq!(run.code(), 2);
    assert!(run.stderr().contains("frobnicate"), "{}", run.stderr());
    assert!(run.stderr().contains("Usage:"), "{}", run.stderr());
}

#[test]
fn an_unknown_config_subcommand_keeps_its_message_and_exit_one() {
    let run = yaran("config-bogus", &["config", "bogus"]);
    assert_eq!(run.code(), 1);
    assert_eq!(
        run.stderr(),
        "Error: unknown config subcommand: bogus\nRun `yaran config --help` for usage.\n"
    );
}

#[test]
fn config_set_reaches_the_config_codes_own_refusal_for_a_negative_value() {
    let run = yaran(
        "config-negative",
        &["config", "set", "ui.left_width_pct", "-1"],
    );
    assert_eq!(run.code(), 1);
    assert_eq!(
        run.stderr(),
        "Error: ui.left_width_pct cannot be -1: invalid value: integer `-1`, expected u16\n"
    );
}

#[test]
fn config_set_with_an_unknown_flag_gives_the_config_codes_flag_message() {
    let run = yaran(
        "config-flag",
        &["config", "set", "server.port", "4000", "--bogus"],
    );
    assert_eq!(run.code(), 1);
    assert_eq!(
        run.stderr(),
        "Error: unknown flag (not repeated, in case it holds a value): `yaran config get` takes --show and `yaran config set` takes --stdin\n"
    );
}

#[test]
fn config_help_is_the_config_codes_own_help_and_says_what_reset_removes() {
    let run = yaran("config-help", &["config", "--help"]);
    assert_eq!(run.code(), 0);
    assert!(
        run.stdout()
            .starts_with("yaran config: manage the yaran configuration file"),
        "{}",
        run.stdout()
    );
    assert!(run.stdout().contains("saved remotes"), "{}", run.stdout());
}

#[test]
fn a_nested_command_prints_its_own_help() {
    let run = yaran("tabs-help", &["agents", "tabs", "ls", "--help"]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert!(
        run.stdout().contains("Usage: yaran agents tabs ls"),
        "{}",
        run.stdout()
    );
}

#[test]
fn top_level_help_lists_the_commands_the_variables_and_the_exit_codes() {
    let run = yaran("top-help", &["--help"]);
    assert_eq!(run.code(), 0);
    let help = run.stdout();
    for needle in [
        "server",
        "config",
        "projects",
        "agents",
        "terminals",
        "macros",
        "operations",
        "--remote",
        "--local",
        "YARAN_HOME",
        "YARAN_REMOTE",
        "1  the change failed",
        "2  the command line is wrong",
        "3  refused",
        "4  yaran isn't running",
        "5  the remote asks for its password",
        "6  the outcome is unknown",
    ] {
        assert!(help.contains(needle), "missing {needle}:\n{help}");
    }
}

#[test]
fn server_help_describes_the_server_and_its_flags() {
    let run = yaran("server-help", &["server", "-h"]);
    assert_eq!(run.code(), 0);
    let help = run.stdout();
    for needle in [
        "--bind",
        "--port",
        "--no-tailscale",
        "yaran config set server.auth.password",
    ] {
        assert!(help.contains(needle), "missing {needle}:\n{help}");
    }
}

#[test]
fn server_flags_are_checked_before_anything_starts() {
    for args in [
        &["server", "--port", "notaport"][..],
        &["server", "--bind", "a:1", "--bind", "b:2"][..],
        &["server", "--what-is-this"][..],
        &["server", "--port", "9", "logs"][..],
    ] {
        let run = yaran("server-bad", args);
        assert_eq!(run.code(), 2, "{args:?}: {}", run.stderr());
    }
}

#[test]
fn remote_and_local_cannot_be_combined() {
    let run = yaran(
        "remote-local",
        &["--local", "--remote", "box", "projects", "ls"],
    );
    assert_eq!(run.code(), 2);
}

#[test]
fn resource_commands_answer_with_no_yaran_running_and_never_create_the_database() {
    const NOT_RUNNING: &str = "yaran isn't running; start it with \"yaran\" or \"yaran server\"\n";
    for (args, code, stdout, stderr) in [
        (&["projects", "ls"][..], 4, "", NOT_RUNNING),
        (&["projects", "list"][..], 4, "", NOT_RUNNING),
        (
            &["projects", "worktrees", "ls", "p"][..],
            4,
            "",
            NOT_RUNNING,
        ),
        (&["agents", "rm", "a"][..], 4, "", NOT_RUNNING),
        (&["agents", "remove", "a", "--yes"][..], 4, "", NOT_RUNNING),
        (
            &["agents", "tabs", "stop", "a", "t"][..],
            4,
            "",
            NOT_RUNNING,
        ),
        (&["terminals", "ls", "-q"][..], 4, "", NOT_RUNNING),
        (
            &["macros", "show", "m"][..],
            1,
            "",
            "no macro has the id or name m\n",
        ),
        (&["env", "ls", "--show"][..], 0, "NAME   VALUE\n", ""),
        (&["server", "connections", "ls"][..], 4, "", NOT_RUNNING),
        (&["operations", "show", "op1"][..], 4, "", NOT_RUNNING),
    ] {
        let dir = home("no-yaran");
        let run = yaran_in(&dir, args, &[]);
        assert_eq!(run.code(), code, "{args:?}: {}", run.stderr());
        assert_eq!(run.stderr(), stderr, "{args:?}");
        assert_eq!(run.stdout(), stdout, "{args:?}");
        assert!(!dir.join("sessions.sqlite3").exists(), "{args:?}");
    }
}

#[test]
fn remotes_are_saved_listed_made_default_and_forgotten() {
    let dir = home("remotes");
    let run = yaran_in(
        &dir,
        &["remote", "add", "lan", "http://192.168.1.20:3890"],
        &[],
    );
    assert_eq!(run.code(), 2);
    assert!(run.stderr().contains("--insecure"), "{}", run.stderr());
    assert!(!dir.join("remotes.toml").exists());

    let run = yaran_in(
        &dir,
        &["remote", "add", "home", "http://127.0.0.1:3890/"],
        &[],
    );
    assert_eq!(run.code(), 0, "{}", run.stderr());
    let run = yaran_in(
        &dir,
        &[
            "remote",
            "add",
            "lan",
            "http://192.168.1.20:3890",
            "--insecure",
        ],
        &[],
    );
    assert_eq!(run.code(), 0, "{}", run.stderr());
    let run = yaran_in(&dir, &["remote", "default", "lan"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());

    let run = yaran_in(&dir, &["remote", "ls", "-q"], &[]);
    assert_eq!(run.stdout(), "home\nlan\n");
    let run = yaran_in(&dir, &["remote", "list", "--format", "json"], &[]);
    let listed: serde_json::Value = serde_json::from_str(&run.stdout()).expect("one array");
    assert_eq!(listed[0]["url"], "http://127.0.0.1:3890");
    assert_eq!(listed[1]["default"], true);
    assert_eq!(listed[1]["insecure"], true);

    let run = yaran_in(&dir, &["remote", "rm", "lan"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    let run = yaran_in(&dir, &["remote", "ls"], &[]);
    assert_eq!(run.stdout().lines().count(), 2, "{}", run.stdout());
    assert!(run.stdout().starts_with("NAME "), "{}", run.stdout());
    let saved = std::fs::read_to_string(dir.join("remotes.toml")).unwrap();
    assert!(!saved.contains("default"), "{saved}");
}

#[test]
fn config_refuses_a_selected_remote_or_an_unreadable_remotes_file_and_touches_nothing() {
    let saved_default =
        "default = \"work\"\n\n[remotes.work]\nurl = \"https://work.example.com\"\n";
    let flag = "yaran config edits this machine's config.toml, and --remote box names another \
                machine; run it without --remote\n";
    let variable = "yaran config edits this machine's config.toml, and YARAN_REMOTE selects work; \
                    run \"yaran --local config …\" to go ahead, or unset YARAN_REMOTE\n";
    let default = "yaran config edits this machine's config.toml, and work is the saved default \
                   remote; run \"yaran --local config …\" to go ahead, or \"yaran remote default \
                   --unset\" to clear the default\n";
    for (case, args, env, remotes, refusal) in [
        (
            "flag",
            &["--remote", "box", "config", "set", "server.port", "4000"][..],
            &[][..],
            None,
            flag,
        ),
        (
            "variable",
            &["config", "set", "ui.theme", "x"][..],
            &[("YARAN_REMOTE", "work")][..],
            None,
            variable,
        ),
        (
            "default",
            &["config", "set", "ui.theme", "x"][..],
            &[][..],
            Some(saved_default),
            default,
        ),
        (
            "default-reset",
            &["config", "reset"][..],
            &[][..],
            Some(saved_default),
            default,
        ),
    ] {
        let dir = home(&format!("config-remote-{case}"));
        if let Some(text) = remotes {
            std::fs::write(dir.join("remotes.toml"), text).unwrap();
        }
        let run = yaran_in(&dir, args, env);
        assert_eq!(run.code(), 2, "{case}: {}", run.stderr());
        assert_eq!(run.stderr(), refusal, "{case}");
        assert_eq!(run.stdout(), "", "{case}");
        assert!(!dir.join("config.toml").exists(), "{case}");
        if remotes.is_some() {
            assert!(dir.join("remotes.toml").exists(), "{case}");
        }
    }
    let dir = home("config-remote-local");
    let run = yaran_in(
        &dir,
        &["--local", "config", "set", "ui.theme", "dux_dark"],
        &[("YARAN_REMOTE", "work")],
    );
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert!(dir.join("config.toml").exists());

    // A remotes.toml that cannot be read stops a config command that would
    // read it, naming the file and both ways on.
    let dir = home("config-remotes-broken");
    std::fs::write(dir.join("remotes.toml"), "default = [\n").unwrap();
    let run = yaran_in(&dir, &["config", "set", "ui.theme", "x"], &[]);
    assert_eq!(run.code(), 1, "{}", run.stderr());
    for needle in ["remotes.toml", "yaran --local config", "yaran config reset"] {
        assert!(run.stderr().contains(needle), "{needle}: {}", run.stderr());
    }
    assert!(!dir.join("config.toml").exists());
    // `--local` never reads it, and a reset goes ahead past it because it
    // removes the file.
    let run = yaran_in(&dir, &["--local", "config", "path"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    let run = yaran_in(&dir, &["config", "reset"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert!(!dir.join("remotes.toml").exists(), "the reset removed it");
}

#[test]
fn config_with_local_runs_as_normal() {
    let run = yaran("config-local", &["--local", "config", "path"]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert!(run.stdout().ends_with("config.toml\n"), "{}", run.stdout());
}

#[test]
fn global_flags_work_beside_a_server_subcommand() {
    let run = yaran("server-remote-logs", &["server", "--remote", "box", "logs"]);
    assert_eq!(
        run.stderr(),
        "no remote is saved as box; \"yaran remote ls\" lists the saved ones\n"
    );
    assert_eq!(run.code(), 2);
}

#[test]
fn server_logs_with_yaran_stopped_print_the_files_last_lines_from_the_file_the_config_names() {
    let dir = home("stopped-logs");
    // Before yaran has ever served there is no file: nothing is printed, and
    // the person is told why.
    let run = yaran_in(&dir, &["server", "logs"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert_eq!(run.stdout(), "");
    assert!(
        run.stderr().contains("There is no server log at"),
        "{}",
        run.stderr()
    );

    std::fs::write(dir.join("server.log"), "one\ntwo\nthree\nfour\n").unwrap();
    let run = yaran_in(&dir, &["server", "logs", "--lines", "2"], &[]);
    assert_eq!((run.code(), run.stdout().as_str()), (0, "three\nfour\n"));
    let run = yaran_in(&dir, &["server", "logs"], &[]);
    assert_eq!(run.stdout(), "one\ntwo\nthree\nfour\n");

    std::fs::write(
        dir.join("config.toml"),
        "[server]\nlog_path = \"elsewhere.log\"\n",
    )
    .unwrap();
    std::fs::write(dir.join("elsewhere.log"), "named\n").unwrap();
    let run = yaran_in(&dir, &["server", "logs"], &[]);
    assert_eq!(run.stdout(), "named\n");
    assert!(!dir.join("sessions.sqlite3").exists());
}

#[test]
fn a_macro_or_env_change_with_no_terminal_and_no_yes_is_refused_and_writes_nothing() {
    const UNCONFIRMED: &str = "add --yes";
    const NOT_A_NAME: &str = "That is not a valid environment variable name";
    for (args, code, says) in [
        (&["macros", "add", "m", "hello"][..], 3, UNCONFIRMED),
        (&["macros", "rm", "m"][..], 3, UNCONFIRMED),
        (&["macros", "remove", "m"][..], 3, UNCONFIRMED),
        (&["env", "set", "TOKEN", "--stdin"][..], 3, UNCONFIRMED),
        (&["env", "rm", "TOKEN"][..], 3, UNCONFIRMED),
        // Refused before it is asked or sent, and never repeated.
        (
            &["env", "set", "zz LEAK.x", "--stdin", "--yes"][..],
            1,
            NOT_A_NAME,
        ),
        (&["env", "rm", "zz LEAK.x"][..], 3, UNCONFIRMED),
    ] {
        let dir = home("unconfirmed-edits");
        let run = yaran_in(&dir, args, &[]);
        assert_eq!(run.code(), code, "{args:?}: {}", run.stderr());
        assert!(run.stderr().contains(says), "{args:?}: {}", run.stderr());
        assert!(!run.stderr().contains("LEAK"), "{args:?}: {}", run.stderr());
        assert!(!dir.join("config.toml").exists(), "{args:?}");
    }
}

#[test]
fn config_arguments_that_look_like_yaran_flags_reach_the_config_code_untouched() {
    for (args, word) in [
        (&["config", "--"][..], "--"),
        (&["config", "--", "path"][..], "--"),
        (&["config", "--local", "path"][..], "--local"),
        (&["config", "--remote=x", "path"][..], "--remote=x"),
    ] {
        let run = yaran("config-raw", args);
        assert_eq!(run.code(), 1, "{args:?}");
        assert_eq!(
            run.stderr(),
            format!(
                "Error: unknown config subcommand: {word}\nRun `yaran config --help` for usage.\n"
            ),
            "{args:?}"
        );
        assert_eq!(run.stdout(), "", "{args:?}");
    }
}

#[test]
fn a_help_flag_inside_a_config_command_prints_the_config_help() {
    for args in [
        &["config", "get", "--help"][..],
        &["config", "set", "x", "y", "--help"][..],
        &["config", "diff", "--raw", "--help"][..],
        &["config", "set", "k", "v", "-h"][..],
    ] {
        let run = yaran("config-inner-help", args);
        assert_eq!(run.code(), 0, "{args:?}: {}", run.stderr());
        assert!(
            run.stdout()
                .starts_with("yaran config: manage the yaran configuration file"),
            "{args:?}: {}",
            run.stdout()
        );
    }
}

#[test]
fn global_flags_before_config_still_apply_to_it() {
    let run = yaran("config-global-before", &["--local", "config", "path"]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    let run = yaran("config-global-before", &["--remote=box", "config", "path"]);
    assert_eq!(run.code(), 2);
}

#[test]
fn a_config_reset_refuses_while_another_yaran_holds_the_lock_and_touches_nothing() {
    for (name, args) in [
        ("reset-locked", vec!["config", "reset"]),
        ("reset-all-locked", vec!["config", "reset", "--all"]),
    ] {
        let dir = home(name);
        let _lock = yaran_core::lockfile::SingleInstanceLock::acquire(&dir.join("dux.lock"))
            .expect("this test plays the running yaran");
        std::fs::write(dir.join("config.toml"), "# mine\n").unwrap();
        std::fs::write(dir.join("sessions.sqlite3"), "not really a database").unwrap();
        let run = yaran_in(&dir, &args, &[]);
        assert_eq!(run.code(), 1, "{name}: {}", run.stderr());
        assert!(
            run.stderr()
                .contains("Another yaran instance is already running"),
            "{name}: {}",
            run.stderr()
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("config.toml")).unwrap(),
            "# mine\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("sessions.sqlite3")).unwrap(),
            "not really a database"
        );
    }
}

/// Answer each request on a socket in `dir` from `reply`, as a running yaran
/// would, and hold `dux.lock` naming that socket.
fn serve_as_yaran(
    dir: &std::path::Path,
    reply: fn(&str) -> (u16, &'static str),
) -> yaran_core::lockfile::SingleInstanceLock {
    use std::io::{BufRead, BufReader, Write};
    let socket = dir.join("yaran.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).expect("bind the socket");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line);
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                    break;
                }
            }
            let path = request_line.split_whitespace().nth(1).unwrap_or_default();
            let (status, body) = match path {
                "/api/v1/build" => (200, r#"{"version":"v1","process":"p","api":1}"#),
                other => reply(other),
            };
            let _ = write!(
                reader.get_mut(),
                "HTTP/1.1 {status} X\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
        }
    });
    let lock = yaran_core::lockfile::SingleInstanceLock::acquire(&dir.join("dux.lock"))
        .expect("this test plays the running yaran");
    std::fs::write(
        dir.join("dux.lock"),
        format!(
            "{}\ncontrol-socket={}\n",
            std::process::id(),
            socket.display()
        ),
    )
    .expect("name the socket in dux.lock");
    lock
}

#[test]
fn an_operation_is_shown_and_exits_with_the_code_of_its_outcome() {
    let dir = home("operations-show");
    let _yaran = serve_as_yaran(&dir, |path| match path {
        "/api/v1/operations/op-ok" => (
            200,
            r#"{"id":"op-ok","kind":"tab.close","state":"succeeded","message":"Closed the tab.","created":[],"removed":[],"parts":[]}"#,
        ),
        "/api/v1/operations/op-part" => (
            200,
            r#"{"id":"op-part","kind":"agent.delete","state":"partial","message":"Deleted web; kept its branch.","created":[],"removed":[],"parts":[]}"#,
        ),
        "/api/v1/operations/op-run" => (
            200,
            r#"{"id":"op-run","kind":"agent.delete","state":"running","message":"","created":[],"removed":[],"parts":[]}"#,
        ),
        _ => (404, r#"{"error":"unknown_operation"}"#),
    });
    for (id, code, state) in [
        ("op-ok", 0, "succeeded"),
        ("op-part", 1, "partial"),
        ("op-run", 6, "running"),
    ] {
        let run = yaran_in(&dir, &["operations", "show", id], &[]);
        assert_eq!(run.code(), code, "{id}: {}", run.stderr());
        assert!(run.stdout().contains(id), "{id}: {}", run.stdout());
        assert!(run.stdout().contains(state), "{id}: {}", run.stdout());
    }
    let run = yaran_in(&dir, &["operations", "show", "op-gone"], &[]);
    assert_eq!(run.code(), 1);
    assert!(run.stderr().contains("op-gone"), "{}", run.stderr());
}

#[test]
fn a_server_start_on_a_config_it_cannot_use_says_why_and_exits_one() {
    let dir = home("server-unloadable");
    std::fs::write(dir.join("config.toml"), "[server\n").unwrap();
    let run = yaran_in(&dir, &["server"], &[]);
    assert_eq!((run.code(), run.stdout().as_str()), (1, ""));
    assert_eq!(
        run.stderr(),
        format!(
            "error: yaran server cannot start: {}/config.toml is not valid TOML, so yaran cannot \
             read [server.auth] and cannot tell whether a password protects the web UI. Fix it \
             at line 1, column 8: unclosed table, expected `]`, then start yaran or reload the \
             config again.\n",
            dir.display()
        )
    );

    let dir = home("server-log-path");
    std::fs::write(
        dir.join("config.toml"),
        format!(
            "[logging]\npath = \"{}\"\n",
            dir.join("config.toml").display()
        ),
    )
    .unwrap();
    let run = yaran_in(&dir, &["server"], &[]);
    assert_eq!((run.code(), run.stdout().as_str()), (1, ""));
    assert_eq!(
        run.stderr(),
        "error: yaran server cannot start: the terminal UI and yaran server will not start with \
         this file: [logging] path points at config.toml, a file yaran keeps for itself, so the log \
         would be written into it. Give the log a file of its own.\n"
    );
}

/// Answer each HTTP request on a loopback port from `reply`, as a remote yaran
/// would. Returns the port.
fn serve_as_remote(reply: fn(&str) -> (u16, &'static str)) -> u16 {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
    let port = listener.local_addr().expect("the bound port").port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            let _ = reader.read_line(&mut request_line);
            let mut length = 0;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                    break;
                }
                if let Some((name, value)) = header.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0; length];
            let _ = reader.read_exact(&mut body);
            let path = request_line.split_whitespace().nth(1).unwrap_or_default();
            let (status, body) = reply(path);
            let _ = write!(
                reader.get_mut(),
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\
                 connection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    port
}

#[test]
fn a_sign_in_over_plain_http_warns_first_and_a_previous_one_it_could_not_end_is_named() {
    let port = serve_as_remote(|path| match path {
        "/api/v1/auth/status" => (
            200,
            r#"{"password_set":true,"required_here":true,"signed_in":false}"#,
        ),
        "/api/v1/auth/cli-login" => (200, r#"{"token":"T0K","expires_at":null}"#),
        "/api/v1/auth/cli-logout" => (500, r#"{"message":"the session store is busy"}"#),
        _ => (404, "{}"),
    });
    let dir = home("remote-login");
    let url = format!("http://127.0.0.1:{port}");
    let run = yaran_in(&dir, &["remote", "add", "box", &url, "--insecure"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());

    let run = yaran_in(&dir, &["remote", "login", "box", "--stdin"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert_eq!(
        run.stderr(),
        "warning: box is reached over plain HTTP, so this password crosses the network \
         unencrypted\n"
    );
    assert_eq!(run.stdout(), "Signed in to box.\n");

    let run = yaran_in(&dir, &["remote", "login", "box", "--stdin"], &[]);
    assert_eq!(run.code(), 0, "{}", run.stderr());
    assert_eq!(
        run.stderr(),
        "warning: box is reached over plain HTTP, so this password crosses the network \
         unencrypted\nSigned in again, but could not tell box to end the previous sign-in: the \
         session store is busy. It ends on its own once it goes unused for [server.auth] \
         cli_token_idle_days.\n"
    );
    assert_eq!(run.stdout(), "Signed in to box.\n");
}
