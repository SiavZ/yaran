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
//! ```text
//! Uses:
//! cloud/protocol/machine.rs
//! ├── cloud::protocol::machine::tests
//! ├── cloud::protocol::meta
//! └── cloud::protocol::rules
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
//! ├── cloud::protocol::machine::tests
//! ├── cloud::push_emitter
//! ├── cloud::push_emitter::tests
//! ├── cloud::push_link
//! ├── cloud::push_queue
//! ├── cloud::push_runner
//! ├── cloud::signed_request
//! ├── cloud::test_support
//! ├── engine::push_hook
//! ├── engine::push_hook::tests
//! ├── yaran-core[test cloud_machine_api]
//! ├── yaran-core[test cloud_push_emitter]
//! ├── yaran-core[test cloud_push_emitter]::mock_worker
//! └── yaran-web::cloud_loop::live_cloud_mode_tests
//! ```
//! <module-headers:end>

use serde::{Deserialize, Serialize};

use super::meta::OrgRef;
use super::rules::{self, Checked, Validate, check};

/// Contains a secret (the tunnel token).
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TunnelCredentials {
    /// The tunnel's id at Cloudflare.
    pub id: String,
    /// The token cloudflared runs the tunnel with. Secret.
    pub token: String,
    /// Which issue of the token this is; a rotation raises it.
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

/// The Access application in front of this machine's hostname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAccess {
    /// The Access team domain the sign-ins come from (`<team>.cloudflareaccess.com`).
    pub team_domain: String,
    /// The Access application's audience tag, which every assertion must carry.
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
    /// The one-time pair code the browser handed back.
    pub code: String,
    /// The PKCE verifier for the challenge the pairing started with.
    pub code_verifier: String,
    /// The version of the yaran claiming the pairing.
    pub yaran_version: String,
    /// The local port yaran serves on, which the tunnel forwards to.
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
    /// The machine's id in the organization.
    pub machine_id: String,
    /// The machine's name, the first label of its hostname.
    pub machine_name: String,
    /// The machine's own hostname, `<machine>-<user>.<zone>`.
    pub hostname: String,
    /// The machine's `https://` address.
    pub url: String,
    /// The local port the tunnel forwards to.
    pub origin_port: i64,
    /// The tunnel and its token.
    pub tunnel: TunnelCredentials,
    /// The Access application guarding the hostname.
    pub access: MachineAccess,
    /// The paired owner's email; only this identity is let in.
    pub owner_email: String,
    /// The owner's slug, the second part of the machine's first label.
    pub user_slug: String,
    /// The organization the machine is paired with.
    pub org: OrgRef,
    /// The protocol version the control plane speaks.
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
    /// The tunnel's id at Cloudflare.
    pub id: String,
    /// The token issue the control plane holds now.
    pub token_version: i64,
}

/// How much a push notification may say about the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushDetail {
    /// The agent's label and project.
    Names,
    /// Only that something needs attention.
    Minimal,
    /// A level this build does not know, read as the most private.
    #[serde(other)]
    Unknown,
}

/// The organization's push settings for this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfigPush {
    /// Whether the organization sends push notifications at all.
    pub enabled: bool,
    /// How much each notification may say.
    pub detail: PushDetail,
}

/// How the machine may send events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfigEvents {
    /// The most events one batch may carry.
    pub max_batch: i64,
    /// The shortest wait between two batches, in milliseconds.
    pub min_interval_ms: i64,
}

/// W5; never contains the token. A higher `tunnel.token_version` than stored means
/// "call W7 with reason sync".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineConfig {
    /// The machine's id in the organization.
    pub machine_id: String,
    /// The machine's own hostname.
    pub hostname: String,
    /// The machine's `https://` address.
    pub url: String,
    /// The local port the tunnel forwards to.
    pub origin_port: i64,
    /// The Access application guarding the hostname.
    pub access: MachineAccess,
    /// The tunnel, without its token.
    pub tunnel: MachineConfigTunnel,
    /// The paired owner's email.
    pub owner_email: String,
    /// The organization's push settings.
    pub push: MachineConfigPush,
    /// How the machine may send events.
    pub events: MachineConfigEvents,
    /// The control plane's clock when it answered, RFC 3339.
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
    /// The agent is waiting for its person.
    NeedsAttention,
    /// Someone is typing into it.
    Typing,
    /// It is working.
    Busy,
    /// It is running and quiet.
    Idle,
    /// Nothing is running for it.
    Detached,
    /// Its process has ended.
    Exited,
}

/// `TabRunEnding` wire kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EndingToken {
    /// The provider could not be started.
    LaunchFailed,
    /// The run ended with a non-zero status.
    Exited,
    /// The run ended and its status could not be read.
    ExitedUnknown,
    /// The run ended cleanly almost at once, so the provider never came up.
    RapidCleanExit,
}

/// What changed about an agent's attention.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    /// The agent started needing its person.
    AttentionRaised,
    /// It stopped needing them.
    AttentionCleared,
}

/// How an agent's run ended badly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitKind {
    /// Its run ended in a way the person should hear about.
    AgentExitedBadly,
}

/// `attention_raised` carries `needs_attention`; `attention_cleared` the tab's state after.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttentionEvent {
    /// The event's id, a UUID the control plane deduplicates on.
    pub id: String,
    /// Whether attention was raised or cleared.
    pub kind: AttentionKind,
    /// When it happened, RFC 3339.
    pub ts: String,
    /// The agent it is about.
    pub agent_id: String,
    /// Omitted for the agent's first (slot) tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// The tab's state after the change.
    pub state: RowStateToken,
    /// Omitted when `push.detail` is `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The agent's label; omitted when `push.detail` is `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// An agent's run ended badly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExitEvent {
    /// The event's id, a UUID the control plane deduplicates on.
    pub id: String,
    /// How the run ended.
    pub kind: ExitKind,
    /// When it happened, RFC 3339.
    pub ts: String,
    /// The agent it is about.
    pub agent_id: String,
    /// The tab whose run ended; omitted for the agent's first (slot) tab.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// The ending, as the tab records it.
    pub ending: EndingToken,
    /// Never copied into a push payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i64>,
    /// The agent's project; omitted when `push.detail` is `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The agent's label; omitted when `push.detail` is `minimal`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

fn check_event_common(
    id: &str,
    ts: &str,
    agent: &str,
    tab: Option<&str>,
    project: Option<&str>,
    label: Option<&str>,
) -> Checked {
    check(rules::is_uuid(id), "id")?;
    check(rules::is_timestamp(ts), "ts")?;
    check(rules::is_yaran_id(agent), "agent_id")?;
    check(tab.is_none_or(rules::is_yaran_id), "tab_id")?;
    check(
        project.is_none_or(|p| rules::chars_between(p, 0, 64)),
        "project",
    )?;
    check(
        label.is_none_or(|l| rules::chars_between(l, 0, 64)),
        "label",
    )
}

impl Validate for AttentionEvent {
    fn validate(&self) -> Checked {
        check_event_common(
            &self.id,
            &self.ts,
            &self.agent_id,
            self.tab_id.as_deref(),
            self.project.as_deref(),
            self.label.as_deref(),
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
            self.tab_id.as_deref(),
            self.project.as_deref(),
            self.label.as_deref(),
        )
    }
}

/// One machine event (the schema's `oneOf`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Event {
    /// An attention change.
    Attention(AttentionEvent),
    /// A run that ended badly.
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
    /// The events, oldest first.
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
    /// The ids taken in for the first time.
    pub accepted: Vec<String>,
    /// The ids the control plane had already seen.
    pub duplicates: Vec<String>,
    /// Whether the organization sends push notifications now.
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

/// Why the machine asks for its tunnel token.
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
    /// The token issue the machine holds.
    pub known_token_version: i64,
    /// Whether to rotate now or only fetch a newer token.
    pub reason: RotateReason,
}

impl Validate for RotateRequest {
    fn validate(&self) -> Checked {
        check(self.known_token_version >= 1, "known_token_version")
    }
}

/// W7's answer: the current token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotateResponse {
    /// The tunnel and its current token.
    pub tunnel: TunnelCredentials,
    /// Whether this request rotated the token.
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
    /// The machine being taken down.
    pub machine_id: String,
    /// The teardown's state at the control plane.
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
    /// The port yaran serves on now.
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
    /// The port the ingress targets now.
    pub origin_port: i64,
    /// Whether the ingress had to change.
    pub changed: bool,
}

impl Validate for OriginUpdateResult {
    fn validate(&self) -> Checked {
        check(rules::is_origin_port(self.origin_port), "origin_port")
    }
}

#[cfg(test)]
#[path = "machine_tests.rs"]
mod tests;
