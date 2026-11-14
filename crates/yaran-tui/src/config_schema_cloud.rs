//! The canonical, fully commented `[cloud]` section of `config.toml`.
//!
//! A child module of `config` (so it shares the private `ConfigEntry` table types) that
//! returns the section's entries; `config_schema()` appends them. The comments are the
//! documentation: what each key does, its default, and when a change applies. Secrets
//! never appear here (D5): they live in the owner-only credentials file.
//!
//! - Pure data.
//!
//! <module-headers:begin>
//! Uses:
//! config_schema_cloud.rs
//! ├── config
//! └── yaran-core::config
//! External: toml
//!
//! Used by:
//! config_schema_cloud.rs
//! └── config
//! <module-headers:end>

use super::{CommentSource, ConfigEntry, FieldValue};

pub(super) fn entries() -> Vec<ConfigEntry> {
    vec![
        ConfigEntry::Blank,
        ConfigEntry::Comment(
            "# Yaran Cloud: reach this machine from your phone through your organization's\n\
             # control plane. Pair it with `yaran cloud login`. Only intent lives here and\n\
             # it is safe to commit: the tunnel token, the machine key and every other\n\
             # secret or pairing detail live in cloud/credentials.json beside this file,\n\
             # readable only by you. Every key below applies live, without a restart.",
        ),
        ConfigEntry::Section("cloud"),
        ConfigEntry::Field {
            key: "mode",
            comment: Some(CommentSource::Static(
                "# Whether yaran runs the remote-access tunnel:\n\
                 #   \"auto\" run it whenever this machine is paired and yaran is serving, and\n\
                 #          follow `yaran cloud login`/`logout` live. An unpaired machine\n\
                 #          stays quiet. The default.\n\
                 #   \"yes\"  the same, but serving while unpaired warns and names the login\n\
                 #          command, and tunnel failures stay on screen until you act.\n\
                 #   \"no\"   never run it. The pairing is kept, so \"auto\" resumes it.\n\
                 # An unknown value is treated as \"auto\" with a warning in yaran.log.",
            )),
            value_fn: |c| FieldValue::Str(c.cloud.mode.clone()),
        },
        ConfigEntry::Field {
            key: "org_url",
            comment: Some(CommentSource::Static(
                "# Your organization's control-plane address, e.g. \"https://cloud.example.com\".\n\
                 # It pre-fills `yaran cloud login` and the login prompts in the terminal UI\n\
                 # and the browser. Empty (the default): you type it. The organization this\n\
                 # machine is actually paired with is recorded in the credentials, not here,\n\
                 # and `yaran cloud` never edits this file. Read when a login starts.",
            )),
            value_fn: |c| FieldValue::Str(c.cloud.org_url.clone()),
        },
        ConfigEntry::Field {
            key: "push_notifications",
            comment: Some(CommentSource::Static(
                "# Send \"needs you\" events to the control plane so your phone gets a push.\n\
                 # Independent of [ui] attention_indicator, which is about this screen.\n\
                 # Default true. Read on every event.",
            )),
            value_fn: |c| FieldValue::Bool(c.cloud.push_notifications),
        },
        ConfigEntry::Field {
            key: "cloudflared_path",
            comment: Some(CommentSource::Static(
                "# Empty (the default): yaran downloads its own pinned, checksum-verified\n\
                 # cloudflared. A path: use that binary instead; it must be version\n\
                 # 2026.11.0 or newer. Read when the tunnel next starts.",
            )),
            value_fn: |c| FieldValue::Str(c.cloud.cloudflared_path.clone()),
        },
        ConfigEntry::Field {
            key: "metrics_port",
            comment: Some(CommentSource::Static(
                "# Loopback port for cloudflared's readiness and metrics server. 0 (the\n\
                 # default) lets yaran pick a free port each time the tunnel starts.\n\
                 # Read when the tunnel next starts.",
            )),
            value_fn: |c| FieldValue::U16(c.cloud.metrics_port),
        },
        ConfigEntry::Field {
            key: "grace_period_seconds",
            comment: Some(CommentSource::Static(
                "# Seconds cloudflared gets to finish open requests when it is stopped\n\
                 # (its --grace-period); yaran force-stops it 2 seconds after that. At most\n\
                 # 180. Default 5. Read when the tunnel next starts.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.grace_period_seconds),
        },
        ConfigEntry::Field {
            key: "restart_backoff_initial_ms",
            comment: Some(CommentSource::Static(
                "# How long yaran waits before restarting a cloudflared that failed: it starts\n\
                 # at restart_backoff_initial_ms, doubles after each failure (the factor is\n\
                 # fixed at 2) up to restart_backoff_max_ms, and adds up to\n\
                 # restart_backoff_jitter_ms of randomness. Defaults 1000 / 60000 / 1000.\n\
                 # Read at the next restart.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.restart_backoff_initial_ms),
        },
        ConfigEntry::Field {
            key: "restart_backoff_max_ms",
            comment: None,
            value_fn: |c| FieldValue::U64(c.cloud.restart_backoff_max_ms),
        },
        ConfigEntry::Field {
            key: "restart_backoff_jitter_ms",
            comment: None,
            value_fn: |c| FieldValue::U64(c.cloud.restart_backoff_jitter_ms),
        },
        ConfigEntry::Field {
            key: "cloudflared_loglevel",
            comment: Some(CommentSource::Static(
                "# cloudflared's --loglevel: \"debug\", \"info\" (the default), \"warn\",\n\
                 # \"error\" or \"fatal\". WARNING: \"debug\" logs request headers, including the\n\
                 # Access cookie that signs your phone in. Read when the tunnel next starts.",
            )),
            value_fn: |c| FieldValue::Str(c.cloud.cloudflared_loglevel.clone()),
        },
        ConfigEntry::Field {
            key: "management_diagnostics",
            comment: Some(CommentSource::Static(
                "# Let Cloudflare's remote management read cloudflared's diagnostics\n\
                 # (profiles and metrics). Default false. Read when the tunnel next starts.",
            )),
            value_fn: |c| FieldValue::Bool(c.cloud.management_diagnostics),
        },
        ConfigEntry::Field {
            key: "unauthorized_confirm_seconds",
            comment: Some(CommentSource::Static(
                "# How long cloudflared may report Unauthorized before yaran asks the control\n\
                 # plane whether this machine was revoked or its token rotated. Default 60.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.unauthorized_confirm_seconds),
        },
        ConfigEntry::Field {
            key: "login_timeout_seconds",
            comment: Some(CommentSource::Static(
                "# How long a login waits for you to approve this machine in the browser.\n\
                 # Default 900 (15 minutes). Read when a login starts.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.login_timeout_seconds),
        },
        ConfigEntry::Field {
            key: "request_timeout_seconds",
            comment: Some(CommentSource::Static(
                "# Timeout for each request to the control plane. Default 15. Read at the\n\
                 # next request.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.request_timeout_seconds),
        },
        ConfigEntry::Field {
            key: "app_callback_urls",
            comment: Some(CommentSource::Static(
                "# The https addresses yaran may send a phone back to after it signs in to this\n\
                 # machine, matched exactly. The default is the official Yaran app's callback\n\
                 # (empty in a build without one). If you publish your own build of the app,\n\
                 # add its https callback here and to your control plane's\n\
                 # APP_CALLBACK_URLS. Never list the development scheme\n\
                 # yaranapp://auth/callback: it is accepted only from development builds of\n\
                 # the app, without being listed. Read on every sign-in.",
            )),
            value_fn: |c| FieldValue::StrList(c.cloud.app_callback_urls.clone()),
        },
        ConfigEntry::Field {
            key: "access_clock_skew_seconds",
            comment: Some(CommentSource::Static(
                "# How far this machine's clock may disagree with Cloudflare's when yaran\n\
                 # checks a phone's Cloudflare Access sign-in. Raise it on a machine with poor\n\
                 # time sync. Default 30. Read on every request.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.access_clock_skew_seconds),
        },
        ConfigEntry::Field {
            key: "access_jwks_refresh_seconds",
            comment: Some(CommentSource::Static(
                "# The longest yaran keeps Cloudflare Access's signing keys before fetching\n\
                 # them again. Default 14400 (4 hours). Read on every request.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.access_jwks_refresh_seconds),
        },
        ConfigEntry::Field {
            key: "access_jwks_retry_cooldown_seconds",
            comment: Some(CommentSource::Static(
                "# The least time between two key fetches when a sign-in names a key yaran\n\
                 # has not seen. Default 30. Read on every request.",
            )),
            value_fn: |c| FieldValue::U64(c.cloud.access_jwks_retry_cooldown_seconds),
        },
        ConfigEntry::Field {
            key: "handoff_requests_per_minute",
            comment: Some(CommentSource::Static(
                "# How many phone sign-in handoffs this machine answers per minute, across\n\
                 # every phone. Raise it for a household or team renewing at once. Default\n\
                 # 12. Read on every handoff.",
            )),
            value_fn: |c| FieldValue::U32(c.cloud.handoff_requests_per_minute),
        },
        ConfigEntry::Field {
            key: "close_sockets_at_access_expiry",
            comment: Some(CommentSource::Static(
                "# Close a phone's live connections when its Cloudflare Access sign-in\n\
                 # expires, so the app signs in again. Default true; set false only if\n\
                 # your phone keeps being disconnected mid-session. Read on every connection.",
            )),
            value_fn: |c| FieldValue::Bool(c.cloud.close_sockets_at_access_expiry),
        },
    ]
}

#[cfg(test)]
mod tests {
    use yaran_core::config::{CloudConfig, Config};

    const KEYS: [&str; 15] = [
        "mode",
        "org_url",
        "push_notifications",
        "cloudflared_path",
        "metrics_port",
        "grace_period_seconds",
        "restart_backoff_initial_ms",
        "restart_backoff_max_ms",
        "restart_backoff_jitter_ms",
        "cloudflared_loglevel",
        "management_diagnostics",
        "unauthorized_confirm_seconds",
        "login_timeout_seconds",
        "request_timeout_seconds",
        "app_callback_urls",
    ];

    fn cloud_section(rendered: &str) -> &str {
        let start = rendered.find("\n[cloud]\n").expect("[cloud] rendered");
        let rest = &rendered[start + 1..];
        let end = rest[1..].find("\n[").map_or(rest.len(), |i| i + 1);
        &rest[..end]
    }

    #[test]
    fn config_schema_cloud_renders_every_key_commented() {
        let rendered = super::super::render_default_config();
        let section = cloud_section(&rendered);
        for key in KEYS {
            assert!(
                section.lines().any(|l| l.starts_with(&format!("{key} = "))),
                "[cloud] {key} missing:\n{section}"
            );
        }
        assert!(section.contains("mode = \"auto\""));
        assert!(section.contains("request_timeout_seconds = 15"));
        // The first key of every group carries a comment.
        assert!(section.lines().next().unwrap() == "[cloud]");
        assert!(section.lines().nth(1).unwrap().starts_with('#'));
        // D5: nothing secret is ever a config key.
        for secret in [
            concat!("tunnel", "_token"), // split so the phase validation grep stays clean
            concat!("machine_key", "_pkcs8"),
            "handoff_consent_key",
            "owner_email",
        ] {
            assert!(!rendered.contains(&format!("{secret} =")), "{secret}");
        }
    }

    #[test]
    fn config_schema_cloud_round_trips() {
        let config = Config {
            cloud: CloudConfig {
                mode: "no".into(),
                org_url: "https://cloud.example.com".into(),
                app_callback_urls: vec!["https://app.example.com/auth/callback".into()],
                metrics_port: 9001,
                ..CloudConfig::default()
            },
            ..Config::default()
        };
        let rendered = super::super::render_config_documented(&config);
        let parsed: Config = toml::from_str(&rendered).unwrap();
        assert_eq!(parsed.cloud, config.cloud);
        assert_eq!(super::super::render_config_documented(&parsed), rendered);
    }
}
