//! What the cloud leg needs from the machine's identity: the pairing record, the signed
//! W5/W7/W32 calls, the revocation state and the leg-state file.
//!
//! The leg only ever talks to [`CloudIdentity`], so its tests drive it with a fake;
//! [`PairedIdentity`] is the production implementation over the credentials store and
//! `MachineApi`. The leg's settings are a typed projection of `[cloud]`.
//!
//! - I/O only in [`PairedIdentity`] and the trait's leg-state helpers.
//! - Secrets: `PairedMachine::tunnel_token` is redacted from `Debug`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_identity.rs
//! ├── cloud::config
//! ├── cloud::credentials
//! ├── cloud::leg_state
//! ├── cloud::machine_api
//! ├── cloud::paths
//! ├── cloud::protocol::machine
//! └── config
//! External: anyhow, std, tempfile
//!
//! Used by:
//! cloud/leg_identity.rs
//! ├── background_serve
//! ├── cloud
//! ├── cloud::leg
//! ├── cloud::leg::tests
//! ├── cloud::leg_outcome
//! ├── cloud::leg_run
//! ├── cloud::leg_start
//! ├── cloud::planner
//! ├── cloud::view
//! ├── engine::cloud_mode
//! ├── engine::events
//! ├── viewmodel
//! ├── worker
//! ├── yaran-tui::app
//! ├── yaran-tui::app::background_server
//! ├── yaran-tui::app::cloud_crumb
//! ├── yaran-tui::app::cloud_mode
//! ├── yaran-web::background
//! ├── yaran-web::cloud_loop
//! ├── yaran-web::cloud_loop::live_cloud_mode_tests
//! ├── yaran-web::cloud_mode
//! ├── yaran-web::cloud_mode_routes
//! ├── yaran-web::engine_actor
//! └── yaran[bin yaran]::companion
//! <module-headers:end>

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::cloud::config::CloudConfig;
pub use crate::cloud::config::CloudMode;
pub use crate::cloud::credentials::CredentialsRevision;
use crate::cloud::credentials::{self, Credentials};
use crate::cloud::leg_state;
pub use crate::cloud::leg_state::LegState;
use crate::cloud::machine_api::MachineApi;
pub use crate::cloud::machine_api::MachineApiError;
use crate::cloud::paths::CloudPaths;
use crate::cloud::protocol::machine::MachineConfig;
pub use crate::cloud::protocol::machine::RotateReason;

/// The `[cloud]` keys the leg reads, with `mode` parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudLegSettings {
    pub mode: CloudMode,
    pub cloudflared_path: String,
    pub metrics_port: u16,
    pub grace_period_seconds: u64,
    pub restart_backoff_initial_ms: u64,
    pub restart_backoff_max_ms: u64,
    pub restart_backoff_jitter_ms: u64,
    pub cloudflared_loglevel: String,
    pub management_diagnostics: bool,
    pub unauthorized_confirm_seconds: u64,
    pub request_timeout_seconds: u64,
}

impl From<&CloudConfig> for CloudLegSettings {
    fn from(c: &CloudConfig) -> Self {
        Self {
            mode: c.mode(),
            cloudflared_path: c.cloudflared_path.clone(),
            metrics_port: c.metrics_port,
            grace_period_seconds: c.grace_period_seconds,
            restart_backoff_initial_ms: c.restart_backoff_initial_ms,
            restart_backoff_max_ms: c.restart_backoff_max_ms,
            restart_backoff_jitter_ms: c.restart_backoff_jitter_ms,
            cloudflared_loglevel: c.cloudflared_loglevel.clone(),
            management_diagnostics: c.management_diagnostics,
            unauthorized_confirm_seconds: c.unauthorized_confirm_seconds,
            request_timeout_seconds: c.request_timeout_seconds,
        }
    }
}

impl Default for CloudLegSettings {
    fn default() -> Self {
        Self::from(&CloudConfig::default())
    }
}

impl CloudLegSettings {
    /// Whether a key other than `mode` changed, which restarts a running child.
    pub fn restart_keys_differ(&self, other: &Self) -> bool {
        Self {
            mode: other.mode,
            ..self.clone()
        } != *other
    }
}

/// The leg's settings from the loaded config.
pub fn settings_from_config(config: &crate::config::Config) -> CloudLegSettings {
    CloudLegSettings::from(&config.cloud)
}

/// Write `[cloud] mode` into the in-memory config.
pub fn store_mode(config: &mut crate::config::Config, mode: CloudMode) {
    config.cloud.mode = mode.as_str().to_string();
}

/// The pairing record, as the leg sees it (the leg-facing part of `Credentials`).
#[derive(Clone, PartialEq, Eq)]
pub struct PairedMachine {
    pub hostname: String,
    pub team_domain: String,
    pub aud: String,
    pub owner_email: String,
    pub org_url: String,
    pub org_name: String,
    pub origin_port: u16,
    pub token_version: i64,
    pub tunnel_token: String,
    pub revoked: bool,
}

impl From<Credentials> for PairedMachine {
    fn from(c: Credentials) -> Self {
        Self {
            revoked: c.is_revoked(),
            hostname: c.hostname,
            team_domain: c.team_domain,
            aud: c.aud,
            owner_email: c.owner_email,
            org_url: c.org_url,
            org_name: c.org_name,
            origin_port: c.origin_port,
            token_version: c.token_version,
            tunnel_token: c.tunnel_token,
        }
    }
}

impl std::fmt::Debug for PairedMachine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairedMachine")
            .field("hostname", &self.hostname)
            .field("org_url", &self.org_url)
            .field("origin_port", &self.origin_port)
            .field("token_version", &self.token_version)
            .field("tunnel_token", &"<redacted>")
            .field("revoked", &self.revoked)
            .finish_non_exhaustive()
    }
}

/// Everything the leg needs from the identity. Every method may block; the leg calls them
/// only from its own threads.
pub trait CloudIdentity: Send + Sync {
    /// `<config root>/cloud`: managed binary, token file, leg state.
    fn cloud_dir(&self) -> PathBuf;
    fn revision(&self) -> Option<CredentialsRevision>;
    /// `Ok(None)` when not paired.
    fn load(&self) -> Result<Option<PairedMachine>, String>;
    /// Whether the control plane has said this machine is revoked.
    fn revoked(&self) -> bool;
    /// W5 `GET /v1/machine/config` (a 410 also raises the signal and stamps `revoked_at`).
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError>;
    /// W7; on success the token and its version are rewritten in the credentials.
    fn rotate(&self, reason: RotateReason) -> Result<(), MachineApiError>;
    /// W32 `PUT /v1/machine/origin`; on success `origin_port` is rewritten.
    fn set_origin(&self, port: u16) -> Result<(), MachineApiError>;

    fn cloud_paths(&self) -> CloudPaths {
        CloudPaths::from_dir(&self.cloud_dir())
    }

    fn write_leg_state(&self, record: &LegState) -> anyhow::Result<()> {
        leg_state::write(&self.cloud_paths(), record)
    }

    fn read_leg_state(&self) -> Option<LegState> {
        leg_state::read(&self.cloud_paths())
    }

    fn clear_leg_state(&self) {
        let _ = leg_state::remove(&self.cloud_paths());
    }
}

/// The production identity: the credentials file and the signed control-plane client.
pub struct PairedIdentity {
    pub paths: CloudPaths,
    pub request_timeout: Duration,
}

impl PairedIdentity {
    fn api(&self) -> Result<MachineApi, MachineApiError> {
        MachineApi::paired(&self.paths, self.request_timeout)
    }
}

impl CloudIdentity for PairedIdentity {
    fn cloud_dir(&self) -> PathBuf {
        self.paths.dir.clone()
    }
    fn revision(&self) -> Option<CredentialsRevision> {
        credentials::revision(&self.paths)
    }
    fn load(&self) -> Result<Option<PairedMachine>, String> {
        credentials::read(&self.paths)
            .map(|c| c.map(PairedMachine::from))
            .map_err(|e| e.to_string())
    }
    fn revoked(&self) -> bool {
        // Every 410 path raises the signal and stamps `revoked_at`, so the file is the
        // durable answer (a re-pair clears it, which a process-wide counter cannot).
        credentials::read(&self.paths)
            .ok()
            .flatten()
            .is_some_and(|c| c.is_revoked())
    }
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError> {
        self.api()?.config()
    }
    fn rotate(&self, reason: RotateReason) -> Result<(), MachineApiError> {
        self.api()?.rotate(reason).map(|_| ())
    }
    fn set_origin(&self, port: u16) -> Result<(), MachineApiError> {
        self.api()?.set_origin(port).map(|_| ())
    }
}

/// The identity a serve uses.
pub fn production_identity(
    config_root: &Path,
    settings: &CloudLegSettings,
) -> Arc<dyn CloudIdentity> {
    Arc::new(PairedIdentity {
        paths: CloudPaths::from_root(config_root),
        request_timeout: Duration::from_secs(settings.request_timeout_seconds.max(1)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_project_the_cloud_section() {
        let mut config = crate::config::Config::default();
        assert_eq!(settings_from_config(&config), CloudLegSettings::default());
        store_mode(&mut config, CloudMode::No);
        config.cloud.metrics_port = 9;
        let s = settings_from_config(&config);
        assert_eq!((s.mode, s.metrics_port), (CloudMode::No, 9));
        assert_eq!(config.cloud.mode, "no");
    }

    #[test]
    fn restart_keys_ignore_the_mode() {
        let base = CloudLegSettings::default();
        let mode_only = CloudLegSettings {
            mode: CloudMode::No,
            ..base.clone()
        };
        assert!(!base.restart_keys_differ(&mode_only));
        let port = CloudLegSettings {
            metrics_port: 9,
            ..base.clone()
        };
        assert!(base.restart_keys_differ(&port));
    }

    #[test]
    fn the_token_is_redacted_from_debug() {
        let m = PairedMachine {
            hostname: "h".into(),
            team_domain: String::new(),
            aud: String::new(),
            owner_email: String::new(),
            org_url: String::new(),
            org_name: String::new(),
            origin_port: 3890,
            token_version: 1,
            tunnel_token: "sekrit".into(),
            revoked: false,
        };
        assert!(!format!("{m:?}").contains("sekrit"));
    }

    #[test]
    fn an_unpaired_machine_loads_nothing_and_its_leg_state_round_trips() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let id = production_identity(dir.path(), &CloudLegSettings::default());
        assert_eq!(id.load().unwrap(), None);
        assert!(!id.revoked());
        assert_eq!(id.revision(), None);
        assert!(matches!(id.set_origin(1), Err(MachineApiError::NotPaired)));
        let record = LegState {
            schema: leg_state::LEG_STATE_SCHEMA,
            pid: 1,
            pgid: 1,
            binary: "/bin/cf".into(),
            metrics_addr: "127.0.0.1:1".into(),
            state: leg_state::READY.into(),
            since: "now".into(),
            child_start_time: 7,
        };
        id.write_leg_state(&record).unwrap();
        assert_eq!(id.read_leg_state(), Some(record));
        let mode = std::fs::metadata(id.cloud_paths().leg_state)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        id.clear_leg_state();
        assert_eq!(id.read_leg_state(), None);
    }
}
