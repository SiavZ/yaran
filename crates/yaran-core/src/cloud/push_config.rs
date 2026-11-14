//! The emitter's two `[cloud]` keys and the resolved settings the `cloud-push` thread runs on.
//!
//! `PushKeys` is flattened into `CloudConfig`, so the keys sit
//! beside `mode` and `push_notifications` in the same section. `PushSettings` is what the
//! engine hands the emitter on start and on every reload: the on/off gate
//! (`push_notifications` and `mode != no`, never `ui.attention_indicator`)
//! plus the two windows, clamped here so a hand-edited value cannot wedge the thread.
//!
//! - Pure values; no I/O.
//!
//! <module-headers:begin>
//! Uses: none
//! External: serde, serde_json, std
//!
//! Used by:
//! cloud/push_config.rs
//! ├── cloud
//! ├── cloud::config
//! ├── cloud::config_patch
//! ├── cloud::push_emitter
//! ├── cloud::push_runner
//! ├── engine::push_hook
//! ├── engine::push_hook::tests
//! └── yaran-core[test cloud_push_emitter]
//! <module-headers:end>

use std::ops::RangeInclusive;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const DEFAULT_COALESCE_SECONDS: u32 = 2;
pub const DEFAULT_OFFLINE_TTL_SECONDS: u32 = 600;
/// Below 30 s a short Wi-Fi drop loses notifications; above a day a "needs you" is history.
pub const OFFLINE_TTL_RANGE: RangeInclusive<u32> = 30..=86_400;
/// A window longer than the TTL would expire every entry before it is due.
pub const MAX_COALESCE_SECONDS: u32 = 300;

/// `[cloud] push_coalesce_seconds` and `[cloud] push_offline_ttl_seconds`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PushKeys {
    /// Seconds an attention change waits so a raise cleared inside it sends nothing;
    /// 0 sends every edge at once. Also the flush interval: an entry is sent the moment
    /// its window ends.
    pub push_coalesce_seconds: u32,
    /// Seconds an unsent event is kept while the control plane is unreachable.
    pub push_offline_ttl_seconds: u32,
}

impl Default for PushKeys {
    fn default() -> Self {
        Self {
            push_coalesce_seconds: DEFAULT_COALESCE_SECONDS,
            push_offline_ttl_seconds: DEFAULT_OFFLINE_TTL_SECONDS,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PushSettings {
    pub enabled: bool,
    pub coalesce: Duration,
    pub offline_ttl: Duration,
}

impl PushSettings {
    pub fn off() -> Self {
        Self::new(false, &PushKeys::default())
    }

    /// `enabled` is the gate: `push_notifications && mode != no`.
    pub fn new(enabled: bool, keys: &PushKeys) -> Self {
        let ttl = keys
            .push_offline_ttl_seconds
            .clamp(*OFFLINE_TTL_RANGE.start(), *OFFLINE_TTL_RANGE.end());
        let coalesce = keys.push_coalesce_seconds.min(MAX_COALESCE_SECONDS);
        Self {
            enabled,
            coalesce: Duration::from_secs(coalesce.into()),
            offline_ttl: Duration::from_secs(ttl.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_settings_clamp_the_keys() {
        let s = |coalesce, ttl| {
            PushSettings::new(
                true,
                &PushKeys {
                    push_coalesce_seconds: coalesce,
                    push_offline_ttl_seconds: ttl,
                },
            )
        };
        assert_eq!(s(0, 1).offline_ttl, Duration::from_secs(30));
        assert_eq!(s(0, 1).coalesce, Duration::ZERO);
        assert_eq!(s(9_999, 999_999).offline_ttl, Duration::from_secs(86_400));
        assert_eq!(s(9_999, 600).coalesce, Duration::from_secs(300));
        let d = PushSettings::new(true, &PushKeys::default());
        assert_eq!(
            (d.coalesce, d.offline_ttl),
            (Duration::from_secs(2), Duration::from_secs(600))
        );
        assert!(!PushSettings::off().enabled);
    }

    #[test]
    fn push_keys_absent_from_a_file_take_the_defaults() {
        let keys: PushKeys = serde_json::from_str("{}").expect("parses");
        assert_eq!(keys, PushKeys::default());
    }
}
