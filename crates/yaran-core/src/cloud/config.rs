//! The `[cloud]` section of `config.toml`: portable intent for Yaran Cloud only.
//!
//! Everything here is safe to commit and safe over `GET /api/v1/config/raw`. Secrets
//! and pairing-derived values (tunnel token, machine key, handoff consent key, machine
//! id, owner email, ...) live in the owner-only credentials file instead (D5), never
//! here. `mode` is a `String` with a parsed accessor, the `[server] tailscale`
//! precedent, so a typo degrades to `auto` with one load-time warning.
//!
//! - Pure data and parsing; no I/O.
//! - The `app_callback_urls` default is compiled in from the repo-root
//!   `publisher.json` (`YARAN_PUBLISHER_DOMAIN`, set by `build.rs`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud/config.rs
//! ├── cloud::protocol::rules
//! └── cloud::push_config
//! External: serde, toml
//!
//! Used by:
//! cloud/config.rs
//! ├── background_serve
//! ├── cloud
//! ├── cloud::cli
//! ├── cloud::config_patch
//! ├── cloud::leg_identity
//! ├── cloud::status
//! ├── config
//! ├── engine::push_hook
//! ├── yaran-tui::app::background_server
//! ├── yaran-tui::app::cloud_mode
//! ├── yaran-web::cloud_ingress
//! ├── yaran-web::cloud_ingress_tests
//! ├── yaran-web::cloud_mode
//! ├── yaran-web::cloud_routes
//! └── yaran[bin yaran]::companion
//! <module-headers:end>

use serde::{Deserialize, Serialize};

/// Whether yaran runs the cloud tunnel leg.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloudMode {
    /// Run it whenever the machine is paired and yaran is serving; quiet when unpaired.
    #[default]
    Auto,
    /// The same, but serving while unpaired warns, and leg failures are sticky.
    Yes,
    /// Never run it; credentials are kept.
    No,
}

impl CloudMode {
    pub const ALL: [CloudMode; 3] = [Self::Auto, Self::Yes, Self::No];

    /// Parse a config string (case and surrounding whitespace ignored).
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

    /// The warning for an unrecognized value, or `None` for a known mode.
    pub fn unknown_value_warning(s: &str) -> Option<String> {
        if Self::parse(s).is_some() {
            return None;
        }
        Some(format!(
            "unknown [cloud] mode value {s:?}; falling back to \"auto\" (valid: auto, yes, no)"
        ))
    }

    /// Whether the leg runs at all (when paired and serving).
    pub fn wants_leg(self) -> bool {
        match self {
            Self::Auto | Self::Yes => true,
            Self::No => false,
        }
    }

    /// Whether serving while unpaired warns and names the login command.
    pub fn warns_when_unpaired(self) -> bool {
        match self {
            Self::Yes => true,
            Self::Auto | Self::No => false,
        }
    }
}

/// The compiled-in publisher domain (`publisher.json`), or empty.
pub const PUBLISHER_DOMAIN: &str = env!("YARAN_PUBLISHER_DOMAIN");

/// The release callbacks a publisher domain implies: none for an empty value, the
/// `<publisher-domain>` placeholder, or anything that is not a plain hostname.
pub fn callback_urls_for_domain(domain: &str) -> Vec<String> {
    if crate::cloud::protocol::rules::is_hostname(domain) && domain.contains('.') {
        vec![format!("https://{domain}/auth/callback")]
    } else {
        Vec::new()
    }
}

/// `[cloud]` in `config.toml`. Every key applies live; see the canonical comment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CloudConfig {
    /// `auto` / `yes` / `no`; read through [`CloudConfig::mode`].
    pub mode: String,
    /// Default control-plane URL for `yaran cloud login`; empty means you type it.
    pub org_url: String,
    /// Send attention events for phone pushes (Phase 12).
    pub push_notifications: bool,
    /// Empty: yaran's pinned, checksum-verified cloudflared. Otherwise this binary.
    pub cloudflared_path: String,
    /// Loopback port for cloudflared's metrics server; 0 picks one per start.
    pub metrics_port: u16,
    /// cloudflared `--grace-period`, seconds (max 180).
    pub grace_period_seconds: u64,
    pub restart_backoff_initial_ms: u64,
    pub restart_backoff_max_ms: u64,
    pub restart_backoff_jitter_ms: u64,
    /// cloudflared `--loglevel`.
    pub cloudflared_loglevel: String,
    /// cloudflared `--management-diagnostics`.
    pub management_diagnostics: bool,
    /// How long Unauthorized may last before yaran asks the control plane why.
    pub unauthorized_confirm_seconds: u64,
    /// How long login waits for the browser round trip.
    pub login_timeout_seconds: u64,
    /// Timeout for each control-plane request.
    pub request_timeout_seconds: u64,
    /// https callbacks the handoff route may redirect a phone to (Phase 11 enforces).
    pub app_callback_urls: Vec<String>,
    /// Phase 11 §9: the Access JWT check and the handoff route, all read live.
    pub access_clock_skew_seconds: u64,
    pub access_jwks_refresh_seconds: u64,
    pub access_jwks_retry_cooldown_seconds: u64,
    pub handoff_requests_per_minute: u32,
    pub close_sockets_at_access_expiry: bool,
    /// Phase 12: `push_coalesce_seconds` and `push_offline_ttl_seconds`.
    #[serde(flatten)]
    pub push: crate::cloud::push_config::PushKeys,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            mode: CloudMode::Auto.as_str().to_string(),
            org_url: String::new(),
            push_notifications: true,
            cloudflared_path: String::new(),
            metrics_port: 0,
            grace_period_seconds: 5,
            restart_backoff_initial_ms: 1000,
            restart_backoff_max_ms: 60_000,
            restart_backoff_jitter_ms: 1000,
            cloudflared_loglevel: "info".to_string(),
            management_diagnostics: false,
            unauthorized_confirm_seconds: 60,
            login_timeout_seconds: 900,
            request_timeout_seconds: 15,
            app_callback_urls: callback_urls_for_domain(PUBLISHER_DOMAIN),
            access_clock_skew_seconds: 30,
            access_jwks_refresh_seconds: 14_400,
            access_jwks_retry_cooldown_seconds: 30,
            handoff_requests_per_minute: 12,
            close_sockets_at_access_expiry: true,
            push: Default::default(),
        }
    }
}

impl CloudConfig {
    /// The configured mode; an unknown value reads as `Auto` (load already warned).
    pub fn mode(&self) -> CloudMode {
        CloudMode::parse(&self.mode).unwrap_or_default()
    }
}

/// The one-line warning for an unknown `[cloud] mode`, emitted once per load.
pub fn cloud_load_warning(cloud: &CloudConfig) -> Option<String> {
    CloudMode::unknown_value_warning(&cloud.mode)
}

/// Correct an unknown mode to `auto` in memory, returning the warning to log.
pub fn correct_cloud_mode(cloud: &mut CloudConfig) -> Option<String> {
    let warning = cloud_load_warning(cloud)?;
    cloud.mode = CloudMode::Auto.as_str().to_string();
    Some(warning)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_parse_table() {
        for (raw, want) in [
            ("auto", Some(CloudMode::Auto)),
            (" YES ", Some(CloudMode::Yes)),
            ("No", Some(CloudMode::No)),
            ("", None),
            ("true", None),
        ] {
            assert_eq!(CloudMode::parse(raw), want, "{raw:?}");
        }
        for mode in [CloudMode::Auto, CloudMode::Yes, CloudMode::No] {
            assert_eq!(CloudMode::parse(mode.as_str()), Some(mode));
        }
        assert!(CloudMode::Yes.warns_when_unpaired());
        assert!(!CloudMode::Auto.warns_when_unpaired());
        assert!(!CloudMode::No.wants_leg());
    }

    #[test]
    fn an_unknown_mode_corrects_to_auto_with_one_warning() {
        let mut cloud = CloudConfig {
            mode: "sometimes".into(),
            ..CloudConfig::default()
        };
        let warning = correct_cloud_mode(&mut cloud).expect("warns");
        assert!(warning.contains("sometimes") && warning.contains("auto"));
        assert_eq!(cloud.mode, "auto");
        assert_eq!(correct_cloud_mode(&mut cloud), None);
    }

    #[test]
    fn the_callback_default_derives_from_the_publisher_domain() {
        assert_eq!(
            callback_urls_for_domain("app.example.dev"),
            vec!["https://app.example.dev/auth/callback".to_string()]
        );
        assert!(callback_urls_for_domain("<publisher-domain>").is_empty());
        assert!(callback_urls_for_domain("").is_empty());
        assert!(callback_urls_for_domain("evil/path").is_empty());
        assert_eq!(
            CloudConfig::default().app_callback_urls,
            callback_urls_for_domain(PUBLISHER_DOMAIN)
        );
    }

    #[test]
    fn an_absent_section_is_the_default() {
        #[derive(Deserialize)]
        struct Wrap {
            #[serde(default)]
            cloud: CloudConfig,
        }
        let w: Wrap = toml::from_str("").unwrap();
        assert_eq!(w.cloud, CloudConfig::default());
        let w: Wrap = toml::from_str("[cloud]\nmode = \"no\"\n").unwrap();
        assert_eq!(w.cloud.mode(), CloudMode::No);
        assert_eq!(w.cloud.request_timeout_seconds, 15);
    }
}
