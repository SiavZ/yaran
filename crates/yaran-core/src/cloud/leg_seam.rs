//! The seam between the cloud leg (Phase 10) and Phase 09's identity, credentials and
//! `[cloud]` config, coded against 09's document while 09 is built alongside.
//!
//! Every item here is a stand-in for something 09 owns, named as 09 names it:
//! `CloudMode` and the leg's subset of `CloudConfig` (`cloud::config`), the credentials
//! projection (`cloud::credentials`), `MachineApiError` and the W5/W7/W32 calls
//! (`cloud::machine_api`), the `RevocationSignal` (`cloud::revocation`) and the leg-state
//! file (`cloud::leg_state`). Integration replaces the bodies marked `INTEGRATION`; the
//! leg itself only ever talks to [`CloudIdentity`], so tests drive it with a fake.
//!
//! - No I/O except in [`UnwiredIdentity`]'s leg-state file helpers.
//! - Secrets: `PairedMachine::tunnel_token` is redacted from `Debug`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_seam.rs
//! ├── cloud::protocol::machine
//! ├── config
//! └── file_modes
//! External: serde_json, std, tempfile
//!
//! Used by:
//! cloud/leg_seam.rs
//! ├── cloud
//! ├── cloud::leg
//! ├── cloud::leg::tests
//! ├── cloud::leg_outcome
//! ├── cloud::leg_run
//! ├── cloud::leg_start
//! ├── cloud::planner
//! └── cloud::view
//! <module-headers:end>

use std::path::{Path, PathBuf};

use crate::cloud::protocol::machine::MachineConfig;

/// `[cloud] mode` (09's `cloud::config::CloudMode`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudMode {
    /// Run the tunnel whenever paired and serving; an unpaired machine is quiet.
    #[default]
    Auto,
    /// The same, but serving while unpaired warns, and leg failures are sticky.
    Yes,
    /// Never run it; credentials are kept.
    No,
}

impl CloudMode {
    pub const ALL: [CloudMode; 3] = [Self::Auto, Self::Yes, Self::No];

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" => Some(Self::Auto),
            "yes" => Some(Self::Yes),
            "no" => Some(Self::No),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Yes => "yes",
            Self::No => "no",
        }
    }

    pub fn wants_leg(self) -> bool {
        match self {
            Self::Auto | Self::Yes => true,
            Self::No => false,
        }
    }

    pub fn warns_when_unpaired(self) -> bool {
        match self {
            Self::Yes => true,
            Self::Auto | Self::No => false,
        }
    }
}

/// The `[cloud]` keys the leg reads (a subset of 09's `CloudConfig`, same defaults).
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

impl Default for CloudLegSettings {
    fn default() -> Self {
        Self {
            mode: CloudMode::Auto,
            cloudflared_path: String::new(),
            metrics_port: 0,
            grace_period_seconds: 5,
            restart_backoff_initial_ms: 1000,
            restart_backoff_max_ms: 60_000,
            restart_backoff_jitter_ms: 1000,
            cloudflared_loglevel: "info".into(),
            management_diagnostics: false,
            unauthorized_confirm_seconds: 60,
            request_timeout_seconds: 15,
        }
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
///
/// INTEGRATION (09): `config.cloud.leg_settings()`. Until 09's `[cloud]` section lands
/// this build has no such keys, so the defaults (mode `auto`) stand.
pub fn settings_from_config(config: &crate::config::Config) -> CloudLegSettings {
    let _ = config;
    CloudLegSettings::default()
}

/// Write `[cloud] mode` into the in-memory config. Answers whether this build has the key.
///
/// INTEGRATION (09): `config.cloud.mode = mode.as_str().into(); true`.
pub fn store_mode(config: &mut crate::config::Config, mode: CloudMode) -> bool {
    let _ = (config, mode);
    false
}

/// The pairing record, as the leg sees it (09's `Credentials`).
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

/// 09's `CredentialsRevision`: `(dev, ino, len, mtime_ns)` of the credentials file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CredentialsRevision(pub u64, pub u64, pub u64, pub i128);

/// 09's `MachineApiError`, exhaustive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MachineApiError {
    Revoked,
    ProtocolUnsupported { min: i64, max: i64, ours: i64 },
    ClockSkew { server_time: String },
    Refused { code: String, message: String },
    Server { status: u16 },
    Network(String),
    Malformed,
}

/// W7 `RotateRequest.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotateReason {
    User,
    Sync,
}

/// `cloud/leg-state.json` (09 owns the format, this phase writes it). `child_start_time`
/// is this phase's addition so the stale reap can tell a reused pid apart.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LegStateRecord {
    pub pid: u32,
    pub pgid: u32,
    pub binary: PathBuf,
    pub metrics_addr: String,
    pub state: String,
    pub since: String,
    #[serde(default)]
    pub child_start_time: u64,
}

/// Everything the leg needs from 09. Every method may block; the leg calls them only from
/// its own threads.
pub trait CloudIdentity: Send + Sync {
    /// `<config root>/cloud` (09's `CloudPaths`): managed binary, token file, leg state.
    fn cloud_dir(&self) -> PathBuf;
    fn revision(&self) -> Option<CredentialsRevision>;
    /// `Ok(None)` when not paired.
    fn load(&self) -> Result<Option<PairedMachine>, String>;
    /// The process-wide `RevocationSignal`.
    fn revoked(&self) -> bool;
    /// W5 `GET /v1/machine/config` (a 410 also sets the signal and stamps `revoked_at`).
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError>;
    /// W7; on success 09 has rewritten the token and its version in the credentials.
    fn rotate(&self, reason: RotateReason) -> Result<(), MachineApiError>;
    /// W32 `PUT /v1/machine/origin`; on success 09 has rewritten `origin_port`.
    fn set_origin(&self, port: u16) -> Result<(), MachineApiError>;

    fn leg_state_path(&self) -> PathBuf {
        self.cloud_dir().join("leg-state.json")
    }

    fn write_leg_state(&self, record: &LegStateRecord) -> std::io::Result<()> {
        write_leg_state_at(&self.leg_state_path(), record)
    }

    fn read_leg_state(&self) -> Option<LegStateRecord> {
        let text = std::fs::read_to_string(self.leg_state_path()).ok()?;
        serde_json::from_str(&text).ok()
    }

    fn clear_leg_state(&self) {
        let _ = std::fs::remove_file(self.leg_state_path());
    }
}

/// Atomic 0600 write (09's `private_file::write_private_atomic` takes over at integration).
fn write_leg_state_at(path: &Path, record: &LegStateRecord) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(dir) = path.parent() {
        crate::file_modes::create_private_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(crate::file_modes::PRIVATE_FILE_MODE)
        .open(&tmp)?;
    file.write_all(&serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?)?;
    file.sync_all()?;
    std::fs::rename(tmp, path)
}

/// The identity this build uses until 09's lands: never paired, so the leg stays quiet.
///
/// INTEGRATION (09): replace with 09's credentials-backed implementation.
pub struct UnwiredIdentity {
    pub cloud_dir: PathBuf,
}

impl CloudIdentity for UnwiredIdentity {
    fn cloud_dir(&self) -> PathBuf {
        self.cloud_dir.clone()
    }
    fn revision(&self) -> Option<CredentialsRevision> {
        None
    }
    fn load(&self) -> Result<Option<PairedMachine>, String> {
        Ok(None)
    }
    fn revoked(&self) -> bool {
        false
    }
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError> {
        Err(MachineApiError::Network("not paired".into()))
    }
    fn rotate(&self, _: RotateReason) -> Result<(), MachineApiError> {
        Err(MachineApiError::Network("not paired".into()))
    }
    fn set_origin(&self, _: u16) -> Result<(), MachineApiError> {
        Err(MachineApiError::Network("not paired".into()))
    }
}

/// The identity a serve uses. INTEGRATION (09): build it from `CloudPaths`.
pub fn production_identity(config_root: &Path) -> std::sync::Arc<dyn CloudIdentity> {
    std::sync::Arc::new(UnwiredIdentity {
        cloud_dir: config_root.join("cloud"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse_table() {
        for (text, mode) in [
            ("auto", CloudMode::Auto),
            (" YES ", CloudMode::Yes),
            ("No", CloudMode::No),
        ] {
            assert_eq!(CloudMode::parse(text), Some(mode));
            assert_eq!(CloudMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(CloudMode::parse("maybe"), None);
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
    fn the_leg_state_round_trips_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let id = UnwiredIdentity {
            cloud_dir: dir.path().join("cloud"),
        };
        let record = LegStateRecord {
            pid: 1,
            pgid: 1,
            binary: "/bin/cf".into(),
            metrics_addr: "127.0.0.1:1".into(),
            state: "ready".into(),
            since: "now".into(),
            child_start_time: 7,
        };
        id.write_leg_state(&record).unwrap();
        assert_eq!(id.read_leg_state(), Some(record));
        let mode = std::fs::metadata(id.leg_state_path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        id.clear_leg_state();
        assert_eq!(id.read_leg_state(), None);
    }
}
