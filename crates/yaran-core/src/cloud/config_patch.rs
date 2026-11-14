//! Saves the `[cloud]` section into an existing `config.toml` (toml_edit, so the
//! user's comments survive).
//!
//! `config_write::apply_patches` is a hand list: a key missing here is never saved.
//! Every `CloudConfig` field has one line below, and a test round-trips them all.
//!
//! - Pure document edit; no I/O.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/config_patch.rs
//! ├── cloud::config
//! └── config_write
//! External: toml, toml_edit
//!
//! Used by:
//! cloud/config_patch.rs
//! ├── cloud
//! └── config_write
//! <module-headers:end>

use toml_edit::DocumentMut;

use crate::cloud::config::CloudConfig;
use crate::config_write::{
    patch_table_bool, patch_table_str, patch_table_string_array, patch_table_u16, patch_table_u64,
};

const S: &str = "cloud";

/// Write every `[cloud]` key of `cloud` into `doc`.
pub fn patch_cloud(doc: &mut DocumentMut, cloud: &CloudConfig) {
    patch_table_str(doc, S, "mode", &cloud.mode);
    patch_table_str(doc, S, "org_url", &cloud.org_url);
    patch_table_bool(doc, S, "push_notifications", cloud.push_notifications);
    patch_table_str(doc, S, "cloudflared_path", &cloud.cloudflared_path);
    patch_table_u16(doc, S, "metrics_port", cloud.metrics_port);
    patch_table_u64(doc, S, "grace_period_seconds", cloud.grace_period_seconds);
    patch_table_u64(
        doc,
        S,
        "restart_backoff_initial_ms",
        cloud.restart_backoff_initial_ms,
    );
    patch_table_u64(
        doc,
        S,
        "restart_backoff_max_ms",
        cloud.restart_backoff_max_ms,
    );
    patch_table_u64(
        doc,
        S,
        "restart_backoff_jitter_ms",
        cloud.restart_backoff_jitter_ms,
    );
    patch_table_str(doc, S, "cloudflared_loglevel", &cloud.cloudflared_loglevel);
    patch_table_bool(
        doc,
        S,
        "management_diagnostics",
        cloud.management_diagnostics,
    );
    patch_table_u64(
        doc,
        S,
        "unauthorized_confirm_seconds",
        cloud.unauthorized_confirm_seconds,
    );
    patch_table_u64(doc, S, "login_timeout_seconds", cloud.login_timeout_seconds);
    patch_table_u64(
        doc,
        S,
        "request_timeout_seconds",
        cloud.request_timeout_seconds,
    );
    patch_table_string_array(doc, S, "app_callback_urls", &cloud.app_callback_urls);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_key_round_trips_and_user_comments_survive() {
        let mut doc: DocumentMut = "# my notes\n[cloud]\n# keep me\nmode = \"auto\"\n"
            .parse()
            .unwrap();
        let cloud = CloudConfig {
            mode: "no".into(),
            org_url: "https://cloud.example.com".into(),
            push_notifications: false,
            cloudflared_path: "/opt/cf".into(),
            metrics_port: 9000,
            grace_period_seconds: 9,
            restart_backoff_initial_ms: 2,
            restart_backoff_max_ms: 3,
            restart_backoff_jitter_ms: 4,
            cloudflared_loglevel: "warn".into(),
            management_diagnostics: true,
            unauthorized_confirm_seconds: 7,
            login_timeout_seconds: 8,
            request_timeout_seconds: 6,
            app_callback_urls: vec!["https://a.example/auth/callback".into()],
        };
        patch_cloud(&mut doc, &cloud);
        let text = doc.to_string();
        assert!(text.contains("# my notes") && text.contains("# keep me"));
        #[derive(serde::Deserialize)]
        struct Wrap {
            cloud: CloudConfig,
        }
        let parsed: Wrap = toml::from_str(&text).unwrap();
        assert_eq!(parsed.cloud, cloud);
    }
}
