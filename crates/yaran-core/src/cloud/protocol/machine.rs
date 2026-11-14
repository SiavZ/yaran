//! The signed machine API bodies (W4–W8, W32): claim, config, events, rotate, teardown
//! and origin update, as yaran sends and receives them.
//!
//! Requests yaran sends are closed (`deny_unknown_fields`, closed enums); responses it
//! receives ignore unknown fields and decode open enums to `Unknown`. `validate` re-checks
//! every schema constraint serde cannot express.
//!
//! - `ClaimResponse` and `RotateResponse` carry the tunnel token, a secret: never log them
//!   (D5); Phase 09 writes them to the owner-only credentials file.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/protocol/machine.rs
//! ├── cloud::protocol::meta
//! ├── cloud::protocol::rules
//! └── cloud::protocol::test_fixtures
//! External: serde, std
//!
//! Used by:
//! cloud/protocol/machine.rs
//! ├── cloud::actions
//! ├── cloud::credentials
//! ├── cloud::leg::tests
//! ├── cloud::leg_identity
//! ├── cloud::login
//! ├── cloud::machine_api
//! ├── cloud::protocol
//! ├── cloud::signed_request
//! ├── cloud::test_support
//! ├── yaran-core[test cloud_machine_api]
//! └── yaran-web::cloud_loop::live_cloud_mode_tests
//! <module-headers:end>

use serde::{Deserialize, Serialize};

use super::meta::OrgRef;
use super::rules::{self, Checked, Validate, check, check_opt};

/// Contains a secret (the tunnel token).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelCredentials {
    pub id: String,
    pub token: String,
    pub token_version: i64,
}

impl std::fmt::Debug for TunnelCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelCredentials")
            .field("id", &self.id)
            .field("token", &"<redacted>")
            .field("token_version", &self.token_version)
            .finish()
    }
}

impl Validate for TunnelCredentials {
    fn validate(&self) -> Checked {
        check(rules::is_uuid(&self.id), "tunnel.id")?;
        check(rules::chars_between(&self.token, 1, 4096), "tunnel.token")?;
        check(self.token_version >= 1, "tunnel.token_version")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAccess {
    pub team_domain: String,
    pub aud: String,
}

impl Validate for MachineAccess {
    fn validate(&self) -> Checked {
        check(rules::is_hostname(&self.team_domain), "access.team_domain")?;
        check(
            self.aud.len() == 64
                && self
                    .aud
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "access.aud",
        )
    }
}

/// W4, signed with the key named by the pair code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaimRequest {
    pub code: String,
    pub code_verifier: String,
    pub yaran_version: String,
    pub origin_port: i64,
}

impl Validate for ClaimRequest {
    fn validate(&self) -> Checked {
        check(rules::is_b64url_43(&self.code), "code")?;
        check(
            rules::chars_between(&self.code_verifier, 43, 128)
                && self
                    .code_verifier
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._~-".contains(&b)),
            "code_verifier",
        )?;
        check(
            rules::chars_between(&self.yaran_version, 1, 40),
            "yaran_version",
        )?;
        check(rules::is_origin_port(self.origin_port), "origin_port")
    }
}

fn is_https_url(s: &str) -> bool {
    s.starts_with("https://")
}

/// W4 answer; contains a secret (`tunnel.token`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimResponse {
    pub machine_id: String,
    pub machine_name: String,
    pub hostname: String,
    pub url: String,
    pub origin_port: i64,
    pub tunnel: TunnelCredentials,
    pub access: MachineAccess,
    pub owner_email: String,
    pub user_slug: String,
    pub org: OrgRef,
    pub protocol: i64,
}

impl Validate for ClaimResponse {
    fn validate(&self) -> Checked {
        check(rules::is_uuid(&self.machine_id), "machine_id")?;
        check(rules::is_machine_name(&self.machine_name), "machine_name")?;
        check(rules::is_hostname(&self.hostname), "hostname")?;
        check(is_https_url(&self.url), "url")?;
        check(rules::is_origin_port(self.origin_port), "origin_port")?;
        self.tunnel.validate()?;
        self.access.validate()?;
        check(rules::is_email(&self.owner_email), "owner_email")?;
        check(rules::is_user_slug(&self.user_slug), "user_slug")?;
        self.org.validate()?;
        check(self.protocol >= 1, "protocol")
    }
}

/// The config's tunnel block: a separate type from `TunnelCredentials` so config can
/// never carry the token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfigTunnel {
    pub id: String,
    pub token_version: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushDetail {
    Names,
    Minimal,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfigPush {
    pub enabled: bool,
    pub detail: PushDetail,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfigEvents {
    pub max_batch: i64,
    pub min_interval_ms: i64,
}

/// W5; never contains the token. A higher `tunnel.token_version` than stored means
/// "call W7 with reason sync".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfig {
    pub machine_id: String,
    pub hostname: String,
    pub url: String,
    pub origin_port: i64,
    pub access: MachineAccess,
    pub tunnel: MachineConfigTunnel,
    pub owner_email: String,
    pub push: MachineConfigPush,
    pub events: MachineConfigEvents,
    pub server_time: String,
}

impl Validate for MachineConfig {
    fn validate(&self) -> Checked {
        check(rules::is_uuid(&self.machine_id), "machine_id")?;
        check(rules::is_hostname(&self.hostname), "hostname")?;
        check(is_https_url(&self.url), "url")?;
        check(rules::is_origin_port(self.origin_port), "origin_port")?;
        self.access.validate()?;
        check(rules::is_uuid(&self.tunnel.id), "tunnel.id")?;
        check(self.tunnel.token_version >= 1, "tunnel.token_version")?;
        check(rules::is_email(&self.owner_email), "owner_email")?;
        check(self.push.detail != PushDetail::Unknown, "push.detail")?;
        check(
            (1..=16).contains(&self.events.max_batch),
            "events.max_batch",
        )?;
        check(self.events.min_interval_ms >= 0, "events.min_interval_ms")?;
        check(rules::is_timestamp(&self.server_time), "server_time")
    }
}

/// yaran's `RowState` wire token, never prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStateToken {
    NeedsAttention,
    Typing,
    Busy,
    Idle,
    Detached,
    Exited,
}

/// `TabRunEnding` wire kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndingToken {
    LaunchFailed,
    Exited,
    ExitedUnknown,
    RapidCleanExit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    AttentionRaised,
    AttentionCleared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitKind {
    AgentExitedBadly,
}

/// `attention_raised` carries `needs_attention`; `attention_cleared` the tab's state after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttentionEvent {
    pub id: String,
    pub kind: AttentionKind,
    pub ts: String,
    pub agent_id: String,
    /// Omitted for the agent's first (slot) tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub state: RowStateToken,
    /// Omitted when `push.detail` is `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExitEvent {
    pub id: String,
    pub kind: ExitKind,
    pub ts: String,
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    pub ending: EndingToken,
    /// Never copied into a push payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn check_event_common(
    id: &str,
    ts: &str,
    agent: &str,
    tab: &Option<String>,
    project: &Option<String>,
    label: &Option<String>,
) -> Checked {
    check(rules::is_uuid(id), "id")?;
    check(rules::is_timestamp(ts), "ts")?;
    check(rules::is_yaran_id(agent), "agent_id")?;
    check_opt(tab, |t| rules::is_yaran_id(t), "tab_id")?;
    check_opt(project, |p| rules::chars_between(p, 0, 64), "project")?;
    check_opt(label, |l| rules::chars_between(l, 0, 64), "label")
}

impl Validate for AttentionEvent {
    fn validate(&self) -> Checked {
        check_event_common(
            &self.id,
            &self.ts,
            &self.agent_id,
            &self.tab_id,
            &self.project,
            &self.label,
        )?;
        check(
            self.kind != AttentionKind::AttentionRaised
                || self.state == RowStateToken::NeedsAttention,
            "state",
        )
    }
}

impl Validate for ExitEvent {
    fn validate(&self) -> Checked {
        check_event_common(
            &self.id,
            &self.ts,
            &self.agent_id,
            &self.tab_id,
            &self.project,
            &self.label,
        )
    }
}

/// One machine event (the schema's `oneOf`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Event {
    Attention(AttentionEvent),
    Exit(ExitEvent),
}

impl Validate for Event {
    fn validate(&self) -> Checked {
        match self {
            Self::Attention(e) => e.validate(),
            Self::Exit(e) => e.validate(),
        }
    }
}

/// W6; always a batch, even of one event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventBatch {
    pub events: Vec<Event>,
}

impl Validate for EventBatch {
    fn validate(&self) -> Checked {
        check((1..=16).contains(&self.events.len()), "events")?;
        self.events.iter().try_for_each(Validate::validate)
    }
}

/// 202 from W6. Org push off is still 202, with `push_enabled: false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventBatchResult {
    pub accepted: Vec<String>,
    pub duplicates: Vec<String>,
    pub push_enabled: bool,
}

impl Validate for EventBatchResult {
    fn validate(&self) -> Checked {
        check(
            self.accepted.iter().all(|id| rules::is_uuid(id)),
            "accepted",
        )?;
        check(
            self.duplicates.iter().all(|id| rules::is_uuid(id)),
            "duplicates",
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RotateReason {
    /// Rotate now.
    User,
    /// Fetch the current token if newer.
    Sync,
}

/// W7.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotateRequest {
    pub known_token_version: i64,
    pub reason: RotateReason,
}

impl Validate for RotateRequest {
    fn validate(&self) -> Checked {
        check(self.known_token_version >= 1, "known_token_version")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotateResponse {
    pub tunnel: TunnelCredentials,
    pub rotated: bool,
}

impl Validate for RotateResponse {
    fn validate(&self) -> Checked {
        self.tunnel.validate()
    }
}

/// 202 from W8/W11/W21. yaran deletes its credentials on 202 or 410 `machine_revoked`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeardownStarted {
    pub machine_id: String,
    pub state: String,
}

impl Validate for TeardownStarted {
    fn validate(&self) -> Checked {
        check(rules::is_uuid(&self.machine_id), "machine_id")?;
        check(self.state == "tearing_down", "state")
    }
}

/// W32, sent when yaran's serving port changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OriginUpdate {
    pub origin_port: i64,
}

impl Validate for OriginUpdate {
    fn validate(&self) -> Checked {
        check(rules::is_origin_port(self.origin_port), "origin_port")
    }
}

/// 202 from W32; `changed: false` means the ingress already targeted that port.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginUpdateResult {
    pub origin_port: i64,
    pub changed: bool,
}

impl Validate for OriginUpdateResult {
    fn validate(&self) -> Checked {
        check(rules::is_origin_port(self.origin_port), "origin_port")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::protocol::test_fixtures::assert_api_type;

    #[test]
    fn machine_types_match_the_schema_fixtures() {
        assert_api_type::<TunnelCredentials>("TunnelCredentials");
        assert_api_type::<MachineAccess>("MachineAccess");
        assert_api_type::<ClaimRequest>("ClaimRequest");
        assert_api_type::<ClaimResponse>("ClaimResponse");
        assert_api_type::<MachineConfig>("MachineConfig");
        assert_api_type::<EventBatch>("EventBatch");
        assert_api_type::<Event>("Event");
        assert_api_type::<AttentionEvent>("AttentionEvent");
        assert_api_type::<ExitEvent>("ExitEvent");
        assert_api_type::<EventBatchResult>("EventBatchResult");
        assert_api_type::<RotateRequest>("RotateRequest");
        assert_api_type::<RotateResponse>("RotateResponse");
        assert_api_type::<TeardownStarted>("TeardownStarted");
        assert_api_type::<OriginUpdate>("OriginUpdate");
        assert_api_type::<OriginUpdateResult>("OriginUpdateResult");
    }

    #[test]
    fn the_tunnel_token_never_reaches_debug_output() {
        let creds = TunnelCredentials {
            id: "x".into(),
            token: "secret-token".into(),
            token_version: 1,
        };
        assert!(!format!("{creds:?}").contains("secret-token"));
    }
}
