//! Only the process holding `dux.lock` opens `sessions.sqlite3`. The command
//! line is a client: everything the database holds it reads and changes
//! through a running yaran. This test holds that line by reading the sources the
//! command line's dispatch runs, so a branch no other test exercises is held
//! to it too.
//!
//! It reads three things:
//!
//! - the command line's own code (the dispatch in `main`, the command tree,
//!   the client commands and `yaran_core::client`), which must name nothing that
//!   opens a database;
//! - every item outside that code it reaches, which must be one of [`VETTED`],
//!   each entry read and recorded as never opening the database. Reaching
//!   anything new fails until someone has read it and added it;
//! - the source of every vetted entry (a whole module, a function's body, or
//!   a type's `impl` blocks), which must name nothing that opens a database
//!   either.
//!
//! It looks one step past the client's own code; a vetted function that starts
//! calling something which opens the database is caught only where that call
//! names it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// What opens a database, or reaches the code that does: the store types,
/// the SQLite crate, and the modules whose work opens the session database.
const OPENS_A_DATABASE: &[&str] = &[
    "SessionStore",
    "WebSessionStore",
    "rusqlite",
    "Connection::",
    "storage::",
    "web_sessions::",
    "process_sessions::",
    "destructive::",
];

/// What the command line's own code must not name on top of that: the
/// database's path, which nothing but opening it needs.
const NAMES_THE_DATABASE: &[&str] = &["sessions_db_path"];

#[derive(Clone, Copy)]
enum Vetted {
    /// A whole module: its file, read whole.
    Module(&'static str),
    /// A function: the file it is defined in and its name; its body is read.
    Function(&'static str, &'static str),
    /// A type: the file it is defined in and its name; its `impl` blocks are
    /// read.
    Type(&'static str, &'static str),
    /// A constant or a plain data type with no code of its own.
    Data,
    /// Opens the database on purpose, for the reason given beside it.
    Exception,
}

/// Every item outside the command line's own code that it reaches, with what
/// was read to vet it. A path is covered by an entry that is the path itself
/// or a module above it.
const VETTED: &[(&str, Vetted, &str)] = &[
    (
        "yaran_core::brand_env::var",
        Vetted::Function("crates/yaran-core/src/brand_env.rs", "var"),
        "reads an environment variable with its legacy-name fallback; the helper only builds a name",
    ),
    (
        "yaran_core::branch_history::BranchAnswersWire",
        Vetted::Type(
            "crates/yaran-core/src/branch_history.rs",
            "BranchAnswersWire",
        ),
        "both delete-dialog boxes' answers as a request carries them, and their validation",
    ),
    (
        "yaran_core::branch_history::BranchOffer",
        Vetted::Type("crates/yaran-core/src/branch_history.rs", "BranchOffer"),
        "the branches a delete dialog offers and what each box loses, asked the dialogs' questions",
    ),
    (
        "yaran_core::branch_history::BranchOrigin",
        Vetted::Type("crates/yaran-core/src/branch_history.rs", "BranchOrigin"),
        "who made a branch the delete dialog offers, and whether yaran vouches for it",
    ),
    (
        "yaran_core::branch_history::Unchecked",
        Vetted::Data,
        "why a delete-dialog box pinned nothing; it has no code of its own",
    ),
    (
        "yaran_core::delete_agent_prose",
        Vetted::Module("crates/yaran-core/src/delete_agent_prose.rs"),
        "the delete dialog's sentences, built as prose from what it is given",
    ),
    (
        "yaran_core::branch_history::BoxWire",
        Vetted::Data,
        "one delete-dialog box's answer; it has no code of its own",
    ),
    (
        "yaran_core::branch_history::PinnedBranch",
        Vetted::Data,
        "a branch name and the commit it was read at",
    ),
    (
        "yaran_core::branch_history::OfferedBranch",
        Vetted::Data,
        "a branch the delete dialog offers, as a server answers with it",
    ),
    (
        "yaran_core::wire::PullRequestSort",
        Vetted::Type("crates/yaran-core/src/wire.rs", "PullRequestSort"),
        "the order a pull-request sort asks for, and the order it means",
    ),
    (
        "yaran_core::wire::PullRequestMove",
        Vetted::Type("crates/yaran-core/src/wire.rs", "PullRequestMove"),
        "where a pull-request move goes, and the place it means",
    ),
    (
        "yaran_core::wire::PullRequestMoveNamed",
        Vetted::Data,
        "the named places a pull-request move goes; it has no code of its own",
    ),
    (
        "yaran_core::pr_reference::parse_typed_reference",
        Vetted::Function(
            "crates/yaran-core/src/pr_reference.rs",
            "parse_typed_reference",
        ),
        "reads typed text as the repository and pull request it names; it parses a string \
         and nothing else, and the module it calls into names no database",
    ),
    (
        "yaran_core::pr_reference::TypedReference",
        Vetted::Type("crates/yaran-core/src/pr_reference.rs", "TypedReference"),
        "the host, repository and number typed text names",
    ),
    (
        "yaran_core::engine::standalone_agent_refusal",
        Vetted::Function(
            "crates/yaran-core/src/engine/mod.rs",
            "standalone_agent_refusal",
        ),
        "formats the sentence a standalone agent is refused a branch feature with",
    ),
    (
        "yaran_core::engine::STANDALONE_ADD_AS_PROJECT_REMEDY",
        Vetted::Data,
        "the remedy sentence a standalone agent's refusals end with",
    ),
    (
        "yaran_core::engine::pull_requests::PR_FEATURE",
        Vetted::Data,
        "the words a standalone agent's pull-request refusal names the feature with",
    ),
    (
        "yaran_core::engine::pull_requests::hidden_move_refusal",
        Vetted::Function(
            "crates/yaran-core/src/engine/pull_requests.rs",
            "hidden_move_refusal",
        ),
        "formats the refusal for moving a hidden pull request",
    ),
    (
        "yaran_core::engine::pull_requests::position_out_of_range_refusal",
        Vetted::Function(
            "crates/yaran-core/src/engine/pull_requests.rs",
            "position_out_of_range_refusal",
        ),
        "formats the refusal for a move to a position the agent does not show",
    ),
    (
        "yaran_core::git::UnpushedCommits",
        Vetted::Data,
        "a count of commits a server answers with; it has no code of its own",
    ),
    (
        "yaran_tui::run_config",
        Vetted::Exception,
        "yaran config: edits config.toml on this machine. Only `yaran config reset --all` opens \
         the database, and only while holding dux.lock with yaran stopped, to stop the programs \
         yaran left running and keep the welcome-seen note",
    ),
    (
        "yaran_tui::run_doctor",
        Vetted::Exception,
        "yaran doctor: reads the session database only after taking dux.lock itself; while a \
         yaran holds the lock it says so and leaves the database to it",
    ),
    (
        "yaran_tui::run_session",
        Vetted::Exception,
        "yaran session purge: the offline purge, only while holding dux.lock with yaran \
         stopped (purge_refuses_while_yaran_holds_the_lock)",
    ),
    (
        "yaran_core::peer::run_peer",
        Vetted::Function("crates/yaran-core/src/peer/router.rs", "run_peer"),
        "routes yaran peer's words; its sessions come from the running yaran it is handed",
    ),
    (
        "yaran_core::human_board::cli::run_board",
        Vetted::Function("crates/yaran-core/src/human_board/cli.rs", "run_board"),
        "yaran board: the board file and the config; its agents come from the running yaran",
    ),
    (
        "yaran_core::cloud::cli::run_cloud",
        Vetted::Function("crates/yaran-core/src/cloud/cli/mod.rs", "run_cloud"),
        "yaran cloud: the cloud credentials file and the control plane",
    ),
    (
        "yaran_core::version::long",
        Vetted::Function("crates/yaran-core/src/version.rs", "long"),
        "the display version and the commit this binary was built from",
    ),
    (
        "yaran_core::reload_policy::remember_startup_exe",
        Vetted::Function(
            "crates/yaran-core/src/reload_policy.rs",
            "remember_startup_exe",
        ),
        "remembers the path this binary was started from, for a later reload",
    ),
    (
        "yaran_core::reload_signal",
        Vetted::Module("crates/yaran-core/src/reload_signal.rs"),
        "installs the SIGUSR1 handler and reads who holds dux.lock",
    ),
    (
        "yaran_core::lockfile",
        Vetted::Module("crates/yaran-core/src/lockfile.rs"),
        "reads dux.lock's text",
    ),
    (
        "yaran_core::config::YaranPaths",
        Vetted::Type("crates/yaran-core/src/config.rs", "YaranPaths"),
        "where yaran keeps its files; naming the database's path does not open it",
    ),
    (
        "yaran_core::config::ServerCliOverrides",
        Vetted::Data,
        "the listener flags of `yaran server`",
    ),
    (
        "yaran_core::config::load_config",
        Vetted::Function("crates/yaran-core/src/config.rs", "load_config"),
        "reads config.toml",
    ),
    (
        "yaran_core::config::load_config_file",
        Vetted::Function("crates/yaran-core/src/config.rs", "load_config_file"),
        "reads config.toml",
    ),
    (
        "yaran_core::config::DEFAULT_CLI_WAIT_TIMEOUT_SECONDS",
        Vetted::Data,
        "the command line's default wait",
    ),
    (
        "yaran_core::control_socket::current_uid",
        Vetted::Function("crates/yaran-core/src/control_socket.rs", "current_uid"),
        "this process's user id, which the control socket's other end must have",
    ),
    (
        "yaran_core::config::check_global_env_var",
        Vetted::Function("crates/yaran-core/src/config.rs", "check_global_env_var"),
        "checks a variable's name",
    ),
    (
        "yaran_core::operations::CREATE_IN_FLIGHT_REFUSAL",
        Vetted::Data,
        "the sentence a create gets while another create runs",
    ),
    (
        "yaran_core::prose",
        Vetted::Module("crates/yaran-core/src/prose.rs"),
        "a sentence as parts, and its plain-text spelling",
    ),
    (
        "yaran_core::status_text::ReviewCopyOutlook",
        Vetted::Data,
        "the data a server answers with about a review copy; it has no code of its own",
    ),
    (
        "yaran_core::gh::GithubHosts",
        Vetted::Type("crates/yaran-core/src/gh.rs", "GithubHosts"),
        "the hosts an address is read as GitHub's on, a plain list with a lookup",
    ),
    (
        "yaran_core::clone_project::clone_dir_name",
        Vetted::Function("crates/yaran-core/src/clone_project.rs", "clone_dir_name"),
        "the folder name at the end of a clone address",
    ),
    (
        "yaran_core::agent_job::review_copy_how",
        Vetted::Function("crates/yaran-core/src/agent_job.rs", "review_copy_how"),
        "the sentence that says how to agree to a review copy",
    ),
    (
        "yaran_core::agent_job::AgreementChannel",
        Vetted::Data,
        "where the user agrees to a review copy, a plain enum with no code of its own",
    ),
    (
        "yaran_core::agent_job::typed_copy_review_outlook",
        Vetted::Function(
            "crates/yaran-core/src/agent_job.rs",
            "typed_copy_review_outlook",
        ),
        "tells whether a typed agent name is spelled like a review copy of a branch",
    ),
    (
        "yaran_core::project_browser::same_directory",
        Vetted::Function("crates/yaran-core/src/project_browser.rs", "same_directory"),
        "whether two paths name one directory on disk",
    ),
    (
        "yaran_core::config_keys::NOT_SHOWN",
        Vetted::Data,
        "the placeholder printed for a hidden value",
    ),
    (
        "yaran_core::config_keys::HeldBack",
        Vetted::Data,
        "whether a printer shows what it holds back by default, as --show asks",
    ),
    (
        "yaran_core::config_resources",
        Vetted::Module("crates/yaran-core/src/config_resources.rs"),
        "macros, providers, keys, themes and env as config.toml holds them",
    ),
    (
        "yaran_core::attachments",
        Vetted::Module("crates/yaran-core/src/attachments.rs"),
        "how an attachment and a connection are described",
    ),
    (
        "yaran_core::file_follow",
        Vetted::Module("crates/yaran-core/src/file_follow.rs"),
        "reads and follows the server log file",
    ),
    (
        "yaran_core::logger::server_log_file",
        Vetted::Function("crates/yaran-core/src/logger.rs", "server_log_file"),
        "where the server log is",
    ),
    (
        "yaran_core::background_serve::TUI_DEVICE_LABEL",
        Vetted::Data,
        "the terminal UI's device label",
    ),
    (
        "yaran_core::device_label",
        Vetted::Module("crates/yaran-core/src/device_label.rs"),
        "shortens a browser's device label",
    ),
    (
        "yaran_core::agent_tabs",
        Vetted::Module("crates/yaran-core/src/agent_tabs.rs"),
        "labels an agent's tabs",
    ),
    (
        "yaran_core::file_modes",
        Vetted::Module("crates/yaran-core/src/file_modes.rs"),
        "owner-only files and folders",
    ),
    (
        "yaran_core::io_retry",
        Vetted::Module("crates/yaran-core/src/io_retry.rs"),
        "retries an interrupted system call",
    ),
    (
        "yaran_core::numeric",
        Vetted::Module("crates/yaran-core/src/numeric.rs"),
        "converts a number from one integer or float type to another",
    ),
    (
        "yaran_core::tailscale",
        Vetted::Module("crates/yaran-core/src/tailscale.rs"),
        "tells a Tailscale address apart",
    ),
    (
        "yaran_core::display_version",
        Vetted::Function("crates/yaran-core/src/lib.rs", "display_version"),
        "the version this binary prints",
    ),
    (
        "yaran_tui::install_canonical_renderer",
        Vetted::Function(
            "crates/yaran-tui/src/config.rs",
            "install_canonical_renderer",
        ),
        "registers how config.toml is written",
    ),
    (
        "yaran_tui::read_sign_in_password",
        Vetted::Function(
            "crates/yaran-tui/src/config_cli.rs",
            "read_sign_in_password",
        ),
        "asks for a password, or reads it from stdin",
    ),
    (
        "yaran_tui::SecretInput",
        Vetted::Data,
        "says whether a secret comes from stdin or a prompt",
    ),
    (
        "yaran_tui::read_env_value",
        Vetted::Function("crates/yaran-tui/src/config_cli.rs", "read_env_value"),
        "asks for a variable's value, or reads it from stdin",
    ),
];

fn workspace() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root")
}

fn read(path: &str) -> String {
    let full = workspace().join(path);
    std::fs::read_to_string(&full).unwrap_or_else(|e| panic!("read {}: {e}", full.display()))
}

/// `text` without its unit tests and its comments: what runs. A test module
/// is left out from its `#[cfg(test)]` to its closing brace (or its `;`), and
/// whatever follows it is read.
fn code_of(text: &str) -> String {
    let mut code = String::new();
    for line in text.lines() {
        let without_comment = match line.find("//") {
            // A `//` inside a string ("http://…") is not a comment.
            Some(at) if line[..at].matches('"').count() % 2 == 0 => &line[..at],
            _ => line,
        };
        code.push_str(without_comment);
        code.push('\n');
    }
    without_test_modules(&code)
}

/// `code` with every `#[cfg(test)]` module taken out, its body included.
fn without_test_modules(code: &str) -> String {
    let mut kept = String::new();
    let mut rest = code;
    while let Some(at) = rest.find("#[cfg(test)]") {
        let after = &rest[at + "#[cfg(test)]".len()..];
        let module = after.trim_start();
        if !module.starts_with("mod ") {
            kept.push_str(&rest[..at + "#[cfg(test)]".len()]);
            rest = after;
            continue;
        }
        kept.push_str(&rest[..at]);
        let start = rest.len() - module.len();
        let end = match (module.find(';'), module.find('{')) {
            (Some(semi), Some(open)) if semi < open => start + semi + 1,
            (Some(semi), None) => start + semi + 1,
            _ => {
                let end = block_end(&rest[start..])
                    .expect("a test module's closing brace, so what follows it is read");
                start + end
            }
        };
        rest = &rest[end..];
    }
    kept.push_str(rest);
    kept
}

/// The command line's own code, file by file, with the crate `crate::`
/// means in each.
fn client_sources() -> Vec<(String, &'static str, String)> {
    let mut sources = Vec::new();
    // In `main`, only `fn main` is the dispatch: the terminal UI and the
    // server it also starts are yaran itself, which takes dux.lock.
    let main = code_of(&read("crates/yaran/src/main.rs"));
    let dispatch = body_of(&main, "fn main()").expect("fn main in main.rs");
    sources.push(("crates/yaran/src/main.rs".to_string(), "yaran", dispatch));
    // The fork's local commands (doctor, session, peer, board, cloud) are split
    // off before clap; their dispatch is the command line's code too.
    for local in [
        "fn run_local_command(",
        "fn run_peer(",
        "fn run_board(",
        "fn run_cloud(",
        "fn ask_local_yaran<",
    ] {
        let body = body_of(&main, local).unwrap_or_else(|| panic!("{local} in main.rs"));
        sources.push(("crates/yaran/src/main.rs".to_string(), "yaran", body));
    }
    for file in [
        "crates/yaran/src/commands.rs",
        "crates/yaran/src/client_commands.rs",
    ] {
        sources.push((file.to_string(), "yaran", code_of(&read(file))));
    }
    let client = workspace().join("crates/yaran-core/src/client");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&client)
        .expect("list yaran-core's client folder")
        .map(|entry| entry.expect("read an entry of the client folder").path())
        .filter(|path| path.extension().is_some_and(|e| e == "rs"))
        .collect();
    files.sort();
    for path in files {
        let name = path
            .file_name()
            .expect("a listed file has a name")
            .to_string_lossy()
            .into_owned();
        // A fake yaran for the client's own unit tests; `mod.rs` declares it
        // under `#[cfg(test)]`.
        if name == "test_server.rs" {
            continue;
        }
        let shown = format!("crates/yaran-core/src/client/{name}");
        sources.push((
            shown,
            "yaran_core",
            code_of(&std::fs::read_to_string(&path).expect("read a client source")),
        ));
    }
    sources
}

/// The text between the braces that follow the first `start` in `code`.
fn body_of(code: &str, start: &str) -> Option<String> {
    let at = code.find(start)?;
    let open = at + code[at..].find('{')?;
    block_end(&code[open..]).map(|end| code[open..open + end].to_string())
}

/// Where the block opened by the first `{` in `code` ends: the index just past
/// its closing brace.
fn block_end(code: &str) -> Option<usize> {
    let open = code.find('{')?;
    let mut depth = 0usize;
    let mut chars = code[open..].char_indices().peekable();
    let mut in_string = false;
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' if in_string => {
                chars.next();
            }
            '"' => in_string = !in_string,
            '\'' if !in_string => {
                // A brace as a character literal: '{' or '}'.
                let rest = &code[open + i..];
                if rest.starts_with("'{'") || rest.starts_with("'}'") {
                    chars.next();
                    chars.next();
                }
            }
            '{' if !in_string => depth += 1,
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    return Some(open + i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// Every `fn name` definition's body in `code` (a name defined in more than
/// one `impl` is read in each).
fn function_bodies(code: &str, name: &str) -> Vec<String> {
    let mut bodies = Vec::new();
    let needle = format!("fn {name}");
    let mut from = 0;
    while let Some(found) = code[from..].find(&needle) {
        let at = from + found;
        let after = code[at + needle.len()..].chars().next();
        if matches!(after, Some('(' | '<')) {
            bodies.extend(body_of(&code[at..], &needle));
        }
        from = at + needle.len();
    }
    bodies
}

/// The bodies of every `impl` block for `ty` in `code`, trait impls included.
fn impl_bodies(code: &str, ty: &str) -> Vec<String> {
    let mut bodies = Vec::new();
    for (at, _) in code.match_indices("impl") {
        let header_end = match code[at..].find('{') {
            Some(end) => at + end,
            None => continue,
        };
        let header = &code[at..header_end];
        let names_type = header
            .split(|c: char| !(c.is_alphanumeric() || c == '_'))
            .any(|word| word == ty);
        let starts_item = code[..at]
            .chars()
            .last()
            .is_none_or(|c| c == '\n' || c == ' ');
        if names_type && starts_item && !header.contains(';') {
            bodies.extend(body_of(&code[at..], "impl"));
        }
    }
    bodies
}

/// Every `use` tree in `code`, expanded to the paths it imports, and the
/// code with the `use` statements taken out.
fn split_uses(code: &str) -> (Vec<String>, String) {
    let mut paths = Vec::new();
    let mut rest = String::new();
    let mut remaining = code;
    while let Some(at) = find_use(remaining) {
        rest.push_str(&remaining[..at]);
        let after = &remaining[at..];
        let end = after.find(';').expect("a use statement ends");
        let tree = tidy(&after["use".len()..end]);
        expand(&tree, "", &mut paths);
        remaining = &after[end + 1..];
    }
    rest.push_str(remaining);
    (paths, rest)
}

/// Where the next `use` statement starts: `use` (or `pub use`) as a whole
/// word followed by whitespace.
fn find_use(code: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = code[from..].find("use ") {
        let at = from + found;
        let before = code[..at].chars().last();
        if before.is_none_or(|c| c == '\n' || c == ' ' || c == '{' || c == ';') {
            return Some(at);
        }
        from = at + 4;
    }
    None
}

/// A `use` tree on one line, with no space but the one in ` as `.
fn tidy(tree: &str) -> String {
    let mut one_line = tree.split_whitespace().collect::<Vec<_>>().join(" ");
    for mark in ["{", "}", ",", "::"] {
        one_line = one_line
            .replace(&format!(" {mark}"), mark)
            .replace(&format!("{mark} "), mark);
    }
    one_line
}

fn expand(tree: &str, prefix: &str, out: &mut Vec<String>) {
    let join = |segment: &str| {
        if prefix.is_empty() {
            segment.to_string()
        } else {
            format!("{prefix}::{segment}")
        }
    };
    let Some(open) = tree.find('{') else {
        let path = tree.split(" as ").next().unwrap_or(tree);
        match path {
            "self" => out.push(prefix.to_string()),
            "*" => out.push(join("*")),
            _ => out.push(join(path)),
        }
        return;
    };
    let head = tree[..open].trim_end_matches("::");
    let prefix = if head.is_empty() {
        prefix.to_string()
    } else {
        join(head)
    };
    let inner = &tree[open + 1..tree.len() - 1];
    let mut depth = 0;
    let mut start = 0;
    for (i, c) in inner.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth -= 1,
            ',' if depth == 0 => {
                if !inner[start..i].is_empty() {
                    expand(&inner[start..i], &prefix, out);
                }
                start = i + 1;
            }
            _ => {}
        }
    }
    if !inner[start..].is_empty() {
        expand(&inner[start..], &prefix, out);
    }
}

/// The names the command line's code calls this workspace's crates by: every
/// dependency in `crates/yaran/Cargo.toml` that is a crate of this workspace,
/// under the name its key gives it, a renamed one included.
fn workspace_crates() -> Vec<String> {
    let manifest = read("crates/yaran/Cargo.toml");
    let mut names = Vec::new();
    let mut in_dependencies = false;
    for line in manifest.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_dependencies = line == "[dependencies]";
            continue;
        }
        if !in_dependencies {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_end_matches(".workspace").trim();
        let package = value
            .split_once("package")
            .and_then(|(_, rest)| rest.split('"').nth(1))
            .unwrap_or(key);
        if workspace()
            .join("crates")
            .join(package)
            .join("Cargo.toml")
            .is_file()
        {
            names.push(key.replace('-', "_"));
        }
    }
    names
}

/// Every path rooted at `crate` or at one of `crates` that `code` names
/// outside its `use` statements.
fn inline_paths(code: &str, crates: &[String]) -> Vec<String> {
    let mut paths = Vec::new();
    let roots =
        std::iter::once("crate::".to_string()).chain(crates.iter().map(|c| format!("{c}::")));
    for root in roots {
        for (at, _) in code.match_indices(root.as_str()) {
            let before = code[..at].chars().last();
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == ':') {
                continue;
            }
            let path: String = code[at..]
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == ':')
                .collect();
            paths.push(path.trim_end_matches(':').to_string());
        }
    }
    paths
}

/// `path` with `crate` replaced by the crate it means, or `None` for a path
/// inside the command line's own code or outside this workspace's `crates`.
fn outside(path: &str, krate: &str, crates: &[String]) -> Option<String> {
    let path = match path.strip_prefix("crate::") {
        Some(rest) => format!("{krate}::{rest}"),
        None => path.to_string(),
    };
    let first = path.split("::").next().unwrap_or_default();
    let own = path == "yaran_core::client"
        || path.starts_with("yaran_core::client::")
        || first == "yaran"
        || !crates.iter().any(|name| name == first);
    (!own).then_some(path)
}

fn vetted_for(path: &str) -> Option<&'static (&'static str, Vetted, &'static str)> {
    VETTED
        .iter()
        .find(|(entry, _, _)| path == *entry || path.starts_with(&format!("{entry}::")))
}

fn named(code: &str, tokens: &[&str]) -> Vec<String> {
    tokens
        .iter()
        .filter(|token| code.contains(**token))
        .map(std::string::ToString::to_string)
        .collect()
}

#[test]
fn the_command_line_never_opens_the_session_database() {
    let mut problems = Vec::new();
    let mut reached = BTreeSet::new();
    let crates = workspace_crates();
    for expected in ["yaran_core", "yaran_tui", "yaran_web"] {
        assert!(
            crates.iter().any(|name| name == expected),
            "{expected} is not among the workspace crates read from crates/yaran/Cargo.toml: \
             {crates:?}"
        );
    }

    for (file, krate, code) in client_sources() {
        let forbidden: Vec<&str> = OPENS_A_DATABASE
            .iter()
            .chain(NAMES_THE_DATABASE)
            .copied()
            .collect();
        for token in named(&code, &forbidden) {
            problems.push(format!("{file} names {token}"));
        }
        if code.contains("super::super") {
            problems.push(format!(
                "{file} reaches out of its module through super::super; name the item by its \
                 crate path so it can be vetted"
            ));
        }
        let (uses, rest) = split_uses(&code);
        for path in uses.iter().chain(inline_paths(&rest, &crates).iter()) {
            if let Some(path) = outside(path, krate, &crates) {
                match vetted_for(&path) {
                    Some((entry, _, _)) => {
                        reached.insert(*entry);
                    }
                    None => problems.push(format!(
                        "{file} reaches {path}, which nobody has vetted: read it and everything \
                         it calls, and if none of it opens sessions.sqlite3 add it to VETTED \
                         with what it does"
                    )),
                }
            }
        }
    }

    for (entry, vetted, _) in VETTED {
        if !reached.contains(entry) {
            problems.push(format!(
                "{entry} is vetted but the command line no longer reaches it; take it out of \
                 VETTED"
            ));
        }
        let read_code = |file: &str| code_of(&read(file));
        let bodies = match *vetted {
            Vetted::Module(file) => vec![read_code(file)],
            Vetted::Function(file, name) => function_bodies(&read_code(file), name),
            Vetted::Type(file, name) => impl_bodies(&read_code(file), name),
            Vetted::Data | Vetted::Exception => continue,
        };
        if bodies.is_empty() {
            problems.push(format!(
                "{entry}'s source was not found where VETTED says it is"
            ));
        }
        for body in bodies {
            for token in named(&body, OPENS_A_DATABASE) {
                problems.push(format!(
                    "{entry}, which the command line reaches, names {token}"
                ));
            }
        }
    }

    assert!(
        problems.is_empty(),
        "only the process holding dux.lock opens sessions.sqlite3; the command line reaches it \
         only through a running yaran:\n  {}",
        problems.join("\n  ")
    );
}

#[test]
fn code_after_a_test_module_is_still_read() {
    let text = "fn before() {}\n#[cfg(test)]\nmod tests {\n    fn inside() { let s = \"}\"; }\n}\nfn after() {}\n";
    let code = code_of(text);
    assert!(code.contains("fn before"), "{code}");
    assert!(!code.contains("fn inside"), "{code}");
    assert!(code.contains("fn after"), "{code}");
    let declared = code_of("#[cfg(test)]\nmod tests;\nfn after() {}\n");
    assert!(declared.contains("fn after"), "{declared}");
}
