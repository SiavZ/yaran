//! The cloud leg's state as every surface reads it: one snapshot, one writer.
//!
//! `CloudLoop` (yaran-web) is the only writer of the shared [`SharedCloudView`]; the TUI
//! header crumb, the flip's status screen, `GET /api/v1/cloud/leg` and the bootstrap
//! projection all read it. It never holds a secret.
//!
//! - Cheap to clone; the lock is held only to copy.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/view.rs
//! └── cloud::leg_identity
//! External: serde_json, std
//!
//! Used by:
//! cloud/view.rs
//! ├── background_serve
//! ├── cloud
//! ├── viewmodel
//! ├── yaran-tui::app::background_server
//! ├── yaran-tui::app::cloud_crumb
//! ├── yaran-web::cloud_loop
//! ├── yaran-web::cloud_mode
//! ├── yaran-web::cloud_mode_routes
//! └── yaran[bin yaran]::companion
//! <module-headers:end>

use std::sync::{Arc, Mutex};

use super::leg_identity::CloudMode;

/// Where the leg is. Exhaustive: every surface matches on it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CloudLegState {
    #[default]
    Off,
    Unpaired,
    Acquiring {
        pct: Option<u8>,
    },
    Starting,
    Ready,
    Reconnecting,
    Healing,
    Revoked,
    Failed,
    NotServing,
}

impl CloudLegState {
    /// The word `leg-state.json` and the logs use.
    pub fn word(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Unpaired => "unpaired",
            Self::Acquiring { .. } => "acquiring",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Reconnecting => "reconnecting",
            Self::Healing => "healing",
            Self::Revoked => "revoked",
            Self::Failed => "failed",
            Self::NotServing => "not_serving",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct CloudLegView {
    pub mode: CloudMode,
    #[serde(flatten)]
    pub state: CloudLegState,
    pub hostname: Option<String>,
    pub org_url: Option<String>,
    pub org_name: Option<String>,
    /// RFC 3339 time the state was entered.
    pub since: Option<String>,
    /// The sentence behind a `Failed` or `Revoked` state.
    pub detail: Option<String>,
}

/// The one shared snapshot.
#[derive(Debug, Clone, Default)]
pub struct SharedCloudView(Arc<Mutex<CloudLegView>>);

impl SharedCloudView {
    pub fn snapshot(&self) -> CloudLegView {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Replace the snapshot; answers whether anything a surface shows changed.
    pub fn replace(&self, view: CloudLegView) -> bool {
        let mut slot = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let changed = *slot != view;
        *slot = view;
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_view_serializes_flat_with_its_state() {
        let view = CloudLegView {
            mode: CloudMode::Yes,
            state: CloudLegState::Acquiring { pct: Some(42) },
            hostname: Some("laptop.example.com".into()),
            ..Default::default()
        };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["state"], "acquiring");
        assert_eq!(json["pct"], 42);
        assert_eq!(json["mode"], "yes");
        assert_eq!(serde_json::from_value::<CloudLegView>(json).unwrap(), view);
    }

    #[test]
    fn replace_reports_a_change_once() {
        let shared = SharedCloudView::default();
        let ready = CloudLegView {
            state: CloudLegState::Ready,
            ..Default::default()
        };
        assert!(shared.replace(ready.clone()));
        assert!(!shared.replace(ready));
    }
}
