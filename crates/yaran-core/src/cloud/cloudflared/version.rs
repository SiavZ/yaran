//! cloudflared versions: the floor yaran refuses to go below, and the probe of a
//! user-supplied binary.
//!
//! `MIN_VERSION` is hand-maintained, never generated: 2026.11.0 fixed an Access bypass via
//! matrix parameters (VULN-170057), and per-route `originRequest.access` enforcement is only
//! trustworthy from that release on (03 G2, threat rows T25 and T29). Raising it is a
//! deliberate PR. Nothing below it is ever executed.
//!
//! - The probe runs `<bin> --version` through `bounded_command` with a 5 s cap.
//! - An unparseable answer fails closed, the same as a too-old one.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cloudflared/version.rs
//! ├── bounded_command
//! ├── cloud::cloudflared::pins
//! ├── cloud::cloudflared::test_support
//! └── sanitize
//! External: chrono, std, tempfile
//!
//! Used by:
//! cloud/cloudflared/version.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::acquire
//! └── cloud::leg_start
//! <module-headers:end>

use std::path::Path;
use std::time::Duration;

use super::pins::{PINNED_RELEASED, PINNED_VERSION};
use crate::bounded_command::{CommandOutcome, DEFAULT_READER_DRAIN, run_command_with_timeout};

/// The oldest cloudflared yaran will run, managed or user-supplied. See the module docs.
pub const MIN_VERSION: CfVersion = CfVersion {
    year: 2026,
    month: 11,
    patch: 0,
};

/// Cloudflare supports releases within one year of the latest one.
pub const SUPPORT_WINDOW_DAYS: i64 = 365;
/// The managed pin warns this long after its release, a month before support ends.
pub const PIN_WARN_DAYS: i64 = 330;

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// A cloudflared CalVer release, `YYYY.M.N`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CfVersion {
    pub year: u16,
    pub month: u8,
    pub patch: u16,
}

impl CfVersion {
    /// Parse `2026.11.0`. Anything else, including a trailing suffix, is `None`.
    pub fn parse(text: &str) -> Option<Self> {
        let mut parts = text.trim().split('.');
        let year = parts.next()?.parse().ok()?;
        let month = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() || !(1..=12).contains(&month) {
            return None;
        }
        Some(Self { year, month, patch })
    }

    /// Find the version in `cloudflared --version` output
    /// (`cloudflared version 2026.11.0 (built 2026-11-11-1200 UTC)`).
    pub fn from_version_output(output: &str) -> Option<Self> {
        let mut words = output.split_whitespace();
        while let Some(word) = words.next() {
            if word == "version" {
                return words.next().and_then(Self::parse);
            }
        }
        None
    }
}

impl std::fmt::Display for CfVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.year, self.month, self.patch)
    }
}

/// Why a user-supplied binary will not be run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionRefusal {
    TooOld { found: CfVersion },
    Unparseable { output: String },
    ProbeFailed { detail: String },
}

/// What the probe of a user binary found: its version and whether it is outside
/// Cloudflare's support window (a warning, not a refusal).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbedVersion {
    pub version: CfVersion,
    pub outside_support_window: bool,
}

/// Run `<bin> --version` and judge the answer.
pub fn probe_user_binary(binary: &Path) -> Result<ProbedVersion, VersionRefusal> {
    let mut cmd = std::process::Command::new(binary);
    cmd.arg("--version").env_clear();
    match run_command_with_timeout(
        cmd,
        VERSION_PROBE_TIMEOUT,
        DEFAULT_READER_DRAIN,
        "cloudflared",
    ) {
        CommandOutcome::Completed(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            judge(&text)
        }
        CommandOutcome::TimedOut => Err(VersionRefusal::ProbeFailed {
            detail: format!(
                "`--version` did not answer within {}s",
                VERSION_PROBE_TIMEOUT.as_secs()
            ),
        }),
        CommandOutcome::Failed(detail) => Err(VersionRefusal::ProbeFailed {
            detail: crate::sanitize::for_terminal(&detail),
        }),
    }
}

/// The pure half of the probe.
pub fn judge(output: &str) -> Result<ProbedVersion, VersionRefusal> {
    let Some(version) = CfVersion::from_version_output(output) else {
        let shown: String = crate::sanitize::for_terminal(output.trim())
            .chars()
            .take(120)
            .collect();
        return Err(VersionRefusal::Unparseable { output: shown });
    };
    if version < MIN_VERSION {
        return Err(VersionRefusal::TooOld { found: version });
    }
    Ok(ProbedVersion {
        version,
        outside_support_window: days_older_than_pin(version)
            .is_some_and(|d| d > SUPPORT_WINDOW_DAYS),
    })
}

/// How many days `version` (taken as the first of its month) predates the pinned release.
fn days_older_than_pin(version: CfVersion) -> Option<i64> {
    let released = chrono::NaiveDate::parse_from_str(PINNED_RELEASED, "%Y-%m-%d").ok()?;
    let made = chrono::NaiveDate::from_ymd_opt(i32::from(version.year), version.month.into(), 1)?;
    Some((released - made).num_days())
}

/// Whether the managed pin is nearing the end of Cloudflare's support window on `today`.
pub fn pin_nearing_end_of_support(today: chrono::NaiveDate) -> bool {
    chrono::NaiveDate::parse_from_str(PINNED_RELEASED, "%Y-%m-%d")
        .is_ok_and(|released| (today - released).num_days() > PIN_WARN_DAYS)
}

/// The pinned version, parsed.
pub fn pinned() -> CfVersion {
    CfVersion::parse(PINNED_VERSION).expect("PINNED_VERSION is a CalVer release")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pin_meets_the_floor() {
        assert!(pinned() >= MIN_VERSION);
    }

    #[test]
    fn the_version_table() {
        let ok = |s: &str| judge(&format!("cloudflared version {s} (built x)"));
        assert!(ok("2026.11.0").is_ok());
        assert!(ok("2027.1.3").is_ok());
        for old in ["2026.10.9", "2026.10.0", "2025.4.0"] {
            assert!(
                matches!(ok(old), Err(VersionRefusal::TooOld { .. })),
                "{old} must be refused"
            );
        }
        assert!(matches!(
            judge("cloudflared version banana"),
            Err(VersionRefusal::Unparseable { .. })
        ));
        assert!(matches!(judge(""), Err(VersionRefusal::Unparseable { .. })));
        assert_eq!(CfVersion::parse("2026.11.0-rc1"), None);
        assert_eq!(CfVersion::parse("2026.13.0"), None);
    }

    #[test]
    fn the_support_window_warning() {
        // At the floor nothing is outside the window relative to the current pin.
        let fresh = judge("cloudflared version 2026.11.0").expect("accepted");
        assert!(!fresh.outside_support_window);
        let pin = chrono::NaiveDate::parse_from_str(PINNED_RELEASED, "%Y-%m-%d").unwrap();
        assert!(!pin_nearing_end_of_support(pin));
        assert!(pin_nearing_end_of_support(
            pin + chrono::Duration::days(PIN_WARN_DAYS + 1)
        ));
    }

    #[test]
    fn a_fake_cli_is_probed_and_judged() {
        let dir = tempfile::tempdir().unwrap();
        let ok = super::super::test_support::script(
            dir.path(),
            "new",
            "echo 'cloudflared version 2026.11.0 (built today)'",
        );
        assert_eq!(probe_user_binary(&ok).unwrap().version, MIN_VERSION);
        let old = super::super::test_support::script(
            dir.path(),
            "old",
            "echo 'cloudflared version 2025.4.0'",
        );
        assert!(matches!(
            probe_user_binary(&old),
            Err(VersionRefusal::TooOld { .. })
        ));
        assert!(matches!(
            probe_user_binary(&dir.path().join("missing")),
            Err(VersionRefusal::ProbeFailed { .. })
        ));
    }
}
