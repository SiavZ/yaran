//! One snapshot of this machine's Yaran Cloud state, for every surface.
//!
//! `yaran cloud status`, the TUI's status report and the web's `GET /api/v1/cloud/status`
//! all read this: the credentials summary (never a secret), the `[cloud]` mode, the
//! tunnel leg from `leg-state.json` (pid verified alive), and optionally the control
//! plane's own view (signed W5).
//!
//! - Blocking (file reads, and a network call when `remote` is given): worker or CLI
//!   threads only.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/status.rs
//! ├── cloud::config
//! ├── cloud::credentials
//! ├── cloud::leg_state
//! ├── cloud::machine_api
//! ├── cloud::paths
//! └── cloud::test_support
//! External: serde, serde_json, tempfile
//!
//! Used by:
//! cloud/status.rs
//! ├── cloud
//! ├── cloud::cli::manage
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_render
//! ├── yaran-tui::app::cloud_tests
//! └── yaran-web::cloud_routes
//! <module-headers:end>

use serde::Serialize;

use crate::cloud::config::CloudMode;
use crate::cloud::credentials;
use crate::cloud::leg_state::{self, LegStatus};
use crate::cloud::machine_api::{ApiFactory, MachineApiError};
use crate::cloud::paths::CloudPaths;

/// No secrets; `status --json` prints exactly this.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StatusReport {
    pub paired: bool,
    pub mode: String,
    pub org_url: Option<String>,
    pub org_name: Option<String>,
    pub hostname: Option<String>,
    pub machine_id: Option<String>,
    pub owner_email: Option<String>,
    pub origin_port: Option<u16>,
    pub token_version: Option<i64>,
    pub paired_at: Option<String>,
    pub revoked_at: Option<String>,
    pub leg: Option<LegReport>,
    /// The control plane's view (`None` when not asked or unpaired).
    pub remote: Option<RemoteReport>,
    /// Why the credentials could not be read.
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LegReport {
    pub state: String,
    pub pid: u32,
    pub since: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RemoteReport {
    pub reachable: bool,
    pub revoked: bool,
    pub token_version: Option<i64>,
    pub detail: Option<String>,
}

impl StatusReport {
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some() || self.remote.as_ref().is_some_and(|r| r.revoked)
    }

    /// `yaran cloud status` exit code: 0 ready, 3 leg not running, 4 not paired,
    /// 5 revoked, 1 an error.
    pub fn exit_code(&self) -> i32 {
        if self.error.is_some() {
            1
        } else if !self.paired {
            4
        } else if self.is_revoked() {
            5
        } else if self.remote.as_ref().is_some_and(|r| !r.reachable) {
            1
        } else if self
            .leg
            .as_ref()
            .is_some_and(|l| l.state == leg_state::READY)
        {
            0
        } else {
            3
        }
    }
}

/// Gather the snapshot; `remote` asks the control plane too.
pub fn gather(paths: &CloudPaths, mode: CloudMode, remote: Option<&ApiFactory>) -> StatusReport {
    let mut report = StatusReport {
        mode: mode.as_str().to_string(),
        ..StatusReport::default()
    };
    let creds = match credentials::read(paths) {
        Ok(Some(c)) => c,
        Ok(None) => return report,
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };
    report.paired = true;
    report.org_url = Some(creds.org_url.clone());
    report.org_name = Some(creds.org_name.clone());
    report.hostname = Some(creds.hostname.clone());
    report.machine_id = Some(creds.machine_id.clone());
    report.owner_email = Some(creds.owner_email.clone());
    report.origin_port = Some(creds.origin_port);
    report.token_version = Some(creds.token_version);
    report.paired_at = Some(creds.paired_at.clone());
    report.revoked_at = creds.revoked_at.clone();
    if let LegStatus::Running(s) = leg_state::status(paths) {
        report.leg = Some(LegReport {
            state: s.state,
            pid: s.pid,
            since: s.since,
        });
    }
    if let Some(factory) = remote {
        let answer = factory(&creds.org_url, paths).and_then(|api| api.config());
        report.remote = Some(match answer {
            Ok(cfg) => RemoteReport {
                reachable: true,
                revoked: false,
                token_version: Some(cfg.tunnel.token_version),
                detail: None,
            },
            Err(MachineApiError::Revoked) => RemoteReport {
                reachable: true,
                revoked: true,
                token_version: None,
                detail: None,
            },
            Err(e) => RemoteReport {
                reachable: false,
                revoked: false,
                token_version: None,
                detail: Some(e.to_string()),
            },
        });
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::test_support::{SAMPLE_ORG, pair_sample};

    #[test]
    fn exit_codes_follow_the_state() {
        let root = tempfile::tempdir().unwrap();
        let paths = CloudPaths::from_root(root.path());
        assert_eq!(gather(&paths, CloudMode::Auto, None).exit_code(), 4);
        pair_sample(&paths, SAMPLE_ORG);
        let r = gather(&paths, CloudMode::No, None);
        assert_eq!((r.exit_code(), r.mode.as_str()), (3, "no"));
        credentials::stamp_revoked(&paths).unwrap();
        assert_eq!(gather(&paths, CloudMode::Auto, None).exit_code(), 5);
        let json = serde_json::to_string(&gather(&paths, CloudMode::Auto, None)).unwrap();
        assert!(!json.contains("tunnel-token") && !json.contains("pkcs8"));
    }
}
