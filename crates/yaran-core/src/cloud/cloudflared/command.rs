//! The cloudflared child's command line, environment and process shape.
//!
//! `<bin> tunnel --no-autoupdate --metrics 127.0.0.1:<port> --output json --loglevel <lvl>
//! --grace-period <g>s --management-diagnostics=<bool> run --token-file <path>`.
//!
//! - The token never appears in argv or the environment (D5, T27): it is written to a
//!   0600 file right before each spawn and removed when the leg stops.
//! - The environment is cleared down to `HOME`, `PATH`, `TMPDIR` and `NO_AUTOUPDATE`,
//!   because cloudflared logs every `TUNNEL_`-containing variable in clear and yaran's own
//!   environment may carry `[env]` secrets.
//! - The child leads its own process group so a terminal Ctrl-C never reaches it; on Linux
//!   it also gets `PR_SET_PDEATHSIG(SIGTERM)` (fires when the SPAWNING THREAD exits, which
//!   is why every spawn happens on the leg's one long-lived supervisor thread).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/command.rs
//! ├── bounded_command
//! └── file_modes
//! External: libc, std, tempfile
//!
//! Used by:
//! cloud/cloudflared/command.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::supervisor
//! ├── cloud::cloudflared::supervisor::tests
//! ├── cloud::leg_run
//! └── yaran-web::cloud_loop
//! <module-headers:end>

use std::ffi::OsString;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The environment variables the child inherits from yaran; everything else is dropped.
pub const ENV_ALLOWLIST: &[&str] = &["HOME", "PATH", "TMPDIR"];

/// cloudflared's own cap on `--grace-period`.
pub const MAX_GRACE_SECONDS: u64 = 180;

const LOG_LEVELS: &[&str] = &["debug", "info", "warn", "error", "fatal"];

/// Everything needed to start one cloudflared child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildSpec {
    pub binary: PathBuf,
    pub metrics_port: u16,
    pub loglevel: String,
    pub grace_seconds: u64,
    pub management_diagnostics: bool,
    pub token_file: PathBuf,
}

impl ChildSpec {
    /// The child's arguments: tunnel-level flags before `run`, the token file after it.
    pub fn argv(&self) -> Vec<OsString> {
        let level = if LOG_LEVELS.contains(&self.loglevel.as_str()) {
            self.loglevel.as_str()
        } else {
            "info"
        };
        let mut args: Vec<OsString> = [
            "tunnel".to_string(),
            "--no-autoupdate".into(),
            "--metrics".into(),
            format!("127.0.0.1:{}", self.metrics_port),
            "--output".into(),
            "json".into(),
            "--loglevel".into(),
            level.into(),
            "--grace-period".into(),
            format!("{}s", self.grace_seconds.min(MAX_GRACE_SECONDS)),
            format!("--management-diagnostics={}", self.management_diagnostics),
            "run".into(),
            "--token-file".into(),
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        args.push(self.token_file.clone().into_os_string());
        args
    }

    /// The exact environment the child gets, drawn from `lookup`.
    pub fn env(&self, lookup: impl Fn(&str) -> Option<OsString>) -> Vec<(OsString, OsString)> {
        let mut env: Vec<(OsString, OsString)> = ENV_ALLOWLIST
            .iter()
            .filter_map(|key| lookup(key).map(|v| (OsString::from(key), v)))
            .collect();
        env.push(("NO_AUTOUPDATE".into(), "true".into()));
        env
    }

    /// The `Command`, ready to spawn.
    pub fn command(&self) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.args(self.argv())
            .env_clear()
            .envs(self.env(|k| std::env::var_os(k)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        set_parent_death_signal(&mut cmd);
        cmd
    }
}

#[cfg(target_os = "linux")]
fn set_parent_death_signal(cmd: &mut Command) {
    // SAFETY: prctl is async-signal-safe and touches only the forked child.
    unsafe {
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn set_parent_death_signal(_cmd: &mut Command) {}

/// The metrics port to pass: the configured one, or a free loopback port when it is 0.
/// cloudflared may lose the race for a probed port; it then exits 1 and the restart picks
/// a new one.
pub fn resolve_metrics_port(configured: u16) -> std::io::Result<u16> {
    if configured != 0 {
        return Ok(configured);
    }
    let probe = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(probe.local_addr()?.port())
}

/// Write the tunnel token to a fresh 0600 file (any previous one is replaced).
pub fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    let _ = std::fs::remove_file(path);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(crate::file_modes::PRIVATE_FILE_MODE)
        .open(path)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()
}

/// Remove the token file; absent is fine.
pub fn remove_token_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ChildSpec {
        ChildSpec {
            binary: "/opt/cloudflared".into(),
            metrics_port: 20241,
            loglevel: "info".into(),
            grace_seconds: 5,
            management_diagnostics: false,
            token_file: "/root/cloud/tunnel-token".into(),
        }
    }

    #[test]
    fn argv_carries_the_flags_in_order_and_no_token() {
        let argv: Vec<String> = spec()
            .argv()
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        assert_eq!(
            argv.join(" "),
            "tunnel --no-autoupdate --metrics 127.0.0.1:20241 --output json --loglevel info \
             --grace-period 5s --management-diagnostics=false run --token-file \
             /root/cloud/tunnel-token"
        );
        assert!(!argv.iter().any(|a| a.contains("eyJ")));
        let mut wild = spec();
        wild.loglevel = "trace; rm -rf".into();
        wild.grace_seconds = 9999;
        let argv: Vec<String> = wild
            .argv()
            .into_iter()
            .map(|a| a.into_string().unwrap())
            .collect();
        assert!(argv.contains(&"info".to_string()) && argv.contains(&"180s".to_string()));
    }

    #[test]
    fn the_environment_is_exactly_the_allowlist() {
        let env = spec().env(|k| match k {
            "HOME" => Some("/home/me".into()),
            "PATH" => Some("/usr/bin".into()),
            _ => None,
        });
        let keys: Vec<_> = env.iter().map(|(k, _)| k.to_str().unwrap()).collect();
        assert_eq!(keys, vec!["HOME", "PATH", "NO_AUTOUPDATE"]);
    }

    #[test]
    fn the_token_file_is_owner_only_and_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tunnel-token");
        write_token_file(&path, "old").unwrap();
        write_token_file(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        remove_token_file(&path);
        assert!(!path.exists());
    }

    #[test]
    fn port_zero_resolves_to_a_free_port() {
        assert_eq!(resolve_metrics_port(20241).unwrap(), 20241);
        assert_ne!(resolve_metrics_port(0).unwrap(), 0);
    }

    /// Gated: run by Phase 18 with the cached pinned binary
    /// (`YARAN_TEST_CLOUDFLARED=<path> cargo test -p yaran-core -- --ignored real_cloudflared`).
    /// Offline: a nonexistent token file must fail with 255 and "Failed to read token file",
    /// proving every flag is accepted where yaran puts it.
    #[test]
    #[ignore]
    fn real_cloudflared_accepts_the_flag_placement() {
        let Some(bin) = std::env::var_os("YARAN_TEST_CLOUDFLARED") else {
            panic!("set YARAN_TEST_CLOUDFLARED to the pinned cloudflared binary");
        };
        let dir = tempfile::tempdir().unwrap();
        let spec = ChildSpec {
            binary: bin.into(),
            metrics_port: resolve_metrics_port(0).unwrap(),
            token_file: dir.path().join("missing-token"),
            ..spec()
        };
        let cmd = spec.command();
        let outcome = crate::bounded_command::run_command_with_timeout(
            cmd,
            std::time::Duration::from_secs(20),
            crate::bounded_command::DEFAULT_READER_DRAIN,
            "cloudflared",
        );
        let crate::bounded_command::CommandOutcome::Completed(out) = outcome else {
            panic!("cloudflared did not finish: {outcome:?}");
        };
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            !stderr.contains("flag provided but not defined"),
            "{stderr}"
        );
        assert!(stderr.contains("Failed to read token file"), "{stderr}");
        assert_eq!(out.status.code(), Some(255));
    }
}
