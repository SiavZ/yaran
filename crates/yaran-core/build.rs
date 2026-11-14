use std::env;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=YARAN_RELEASE_BUILD");
    println!("cargo:rerun-if-env-changed=DUX_RELEASE_BUILD");
    let release_build =
        env::var_os("YARAN_RELEASE_BUILD").or_else(|| env::var_os("DUX_RELEASE_BUILD"));
    let display_version = if release_build.as_deref() == Some(std::ffi::OsStr::new("1")) {
        format!("v{}", env!("CARGO_PKG_VERSION"))
    } else {
        "development".to_string()
    };
    println!("cargo:rustc-env=YARAN_DISPLAY_VERSION={display_version}");

    stamp_git_commit();
    stamp_publisher_domain();
}

/// Expose the repo-root `publisher.json`'s `publisher_domain` (Phase 18's one home
/// for it) as `YARAN_PUBLISHER_DOMAIN`, raw; `cloud::config::callback_urls_for_domain`
/// turns a missing file, the `<publisher-domain>` placeholder or junk into no callback.
fn stamp_publisher_domain() {
    let dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let path = std::path::Path::new(&dir).join("../../publisher.json");
    println!("cargo:rerun-if-changed={}", path.display());
    let raw = std::fs::read_to_string(&path).unwrap_or_default();
    // shortcut: a string scan rather than a JSON parser (no build-dependency); the
    // value is validated as a hostname where it is used.
    let domain = raw
        .split_once("\"publisher_domain\"")
        .and_then(|(_, rest)| rest.split_once(':'))
        .and_then(|(_, rest)| rest.trim_start().strip_prefix('"'))
        .and_then(|rest| rest.split_once('"'))
        .map(|(value, _)| value.trim().to_string())
        .unwrap_or_default();
    println!("cargo:rustc-env=YARAN_PUBLISHER_DOMAIN={domain}");
}

/// Embed the short git commit the binary was built from as `YARAN_GIT_COMMIT`,
/// with a `-dirty` suffix when tracked files differ from it, or `unknown`
/// outside a git checkout. The package version is rarely bumped between
/// commits, so it alone cannot tell two builds apart; see `crate::version`.
///
/// Paths are asked of git (`rev-parse --git-path`) rather than built as
/// `<crate>/.git/...`: this crate sits two levels below the repository root,
/// and in a linked worktree `.git` is a file, not a directory.
fn stamp_git_commit() {
    let dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into());
    let commit = git(&dir, &["rev-parse", "--short=7", "HEAD"]);
    let dirty =
        git(&dir, &["status", "--porcelain", "--untracked-files=no"]).map(|out| !out.is_empty());
    let stamp = match (commit, dirty) {
        (Some(c), Some(true)) => format!("{c}-dirty"),
        (Some(c), _) => c,
        (None, _) => "unknown".to_string(),
    };
    println!("cargo:rustc-env=YARAN_GIT_COMMIT={stamp}");

    // Re-stamp on a commit, a checkout, or a ref pack. The `-dirty` suffix is
    // best-effort: editing a tracked file without committing does not re-run
    // this script until one of these changes. The index is deliberately NOT
    // watched: the `git status` above refreshes it, so watching it would re-run
    // this script (and rebuild yaran-core) on every single build.
    for path in ["HEAD", "packed-refs"] {
        if let Some(p) = git(&dir, &["rev-parse", "--git-path", path]) {
            println!("cargo:rerun-if-changed={}", absolute(&dir, &p));
        }
    }
    if let Some(reference) = git(&dir, &["symbolic-ref", "-q", "HEAD"])
        && let Some(p) = git(&dir, &["rev-parse", "--git-path", &reference])
    {
        println!("cargo:rerun-if-changed={}", absolute(&dir, &p));
    }
}

fn absolute(dir: &str, path: &str) -> String {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(dir).join(p).display().to_string()
    }
}

fn git(dir: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}
