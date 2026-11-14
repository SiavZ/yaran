//! The header's cloud segment: what the background serve's tunnel is doing, beside the
//! serving chip.
//!
//! `☁ <hostname>` when Ready, `☁ connecting…` while starting or reconnecting,
//! `☁ revoked` / `☁ failed` in the warning tone, and nothing for `off`, `unpaired` under
//! `auto`, or when nothing serves. Colors come from existing semantic theme tokens. The
//! view moves on the serve's threads with no mutation path on this surface, so the redraw
//! gate compares [`App::cloud_crumb`] rather than waiting for a mark.
//!
//! <module-headers:begin>
//! Uses:
//! app/cloud_crumb.rs
//! ├── app
//! ├── app::test_support
//! ├── yaran-core::cloud::leg_seam
//! └── yaran-core::cloud::view
//! External: none
//!
//! Used by:
//! app/cloud_crumb.rs
//! └── app
//! <module-headers:end>

use super::*;
use yaran_core::cloud::leg_seam::CloudMode;
use yaran_core::cloud::view::{CloudLegState, CloudLegView};

/// The crumb's text and whether it wears the warning tone.
pub(crate) fn crumb_for(view: &CloudLegView) -> Option<(String, bool)> {
    let host = view.hostname.as_deref().unwrap_or("remote access");
    match view.state {
        CloudLegState::Ready => Some((format!("☁ {host}"), false)),
        CloudLegState::Starting | CloudLegState::Reconnecting | CloudLegState::Healing => {
            Some(("☁ connecting…".to_string(), false))
        }
        CloudLegState::Acquiring { pct } => Some((
            match pct {
                Some(pct) => format!("☁ downloading {pct}%"),
                None => "☁ downloading…".to_string(),
            },
            false,
        )),
        CloudLegState::Revoked => Some(("☁ revoked".to_string(), true)),
        CloudLegState::Failed => Some(("☁ failed".to_string(), true)),
        CloudLegState::Unpaired if view.mode == CloudMode::Yes => {
            Some(("☁ not paired".to_string(), true))
        }
        CloudLegState::Unpaired | CloudLegState::Off | CloudLegState::NotServing => None,
    }
}

impl App {
    /// The crumb for the background serve's cloud leg, `None` when nothing serves.
    pub(crate) fn cloud_crumb(&self) -> Option<(String, bool)> {
        let view = self.companion.as_ref()?.cloud_view()?;
        crumb_for(&view)
    }

    pub(crate) fn push_cloud_crumb(&self, spans: &mut Vec<Span<'static>>) {
        let Some((label, warning)) = self.cloud_crumb() else {
            return;
        };
        let fg = if warning {
            self.theme.warning_fg
        } else {
            self.theme.session_active
        };
        spans.push(Span::styled(
            format!(" {label}"),
            Style::default().fg(fg).bg(self.theme.header_bg),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(state: CloudLegState, mode: CloudMode) -> CloudLegView {
        CloudLegView {
            mode,
            state,
            hostname: Some("laptop.example.com".into()),
            ..CloudLegView::default()
        }
    }

    #[test]
    fn crumb_text_for_every_state() {
        let a = CloudMode::Auto;
        let cases = [
            (CloudLegState::Off, a, None),
            (CloudLegState::NotServing, a, None),
            (CloudLegState::Unpaired, a, None),
            (
                CloudLegState::Unpaired,
                CloudMode::Yes,
                Some(("☁ not paired", true)),
            ),
            (
                CloudLegState::Acquiring { pct: Some(42) },
                a,
                Some(("☁ downloading 42%", false)),
            ),
            (
                CloudLegState::Acquiring { pct: None },
                a,
                Some(("☁ downloading…", false)),
            ),
            (CloudLegState::Starting, a, Some(("☁ connecting…", false))),
            (
                CloudLegState::Reconnecting,
                a,
                Some(("☁ connecting…", false)),
            ),
            (CloudLegState::Healing, a, Some(("☁ connecting…", false))),
            (
                CloudLegState::Ready,
                a,
                Some(("☁ laptop.example.com", false)),
            ),
            (CloudLegState::Revoked, a, Some(("☁ revoked", true))),
            (CloudLegState::Failed, a, Some(("☁ failed", true))),
        ];
        for (state, mode, want) in cases {
            let got = crumb_for(&view(state, mode));
            assert_eq!(
                got.as_ref().map(|(t, w)| (t.as_str(), *w)),
                want,
                "{state:?} {mode:?}"
            );
        }
    }

    #[test]
    fn no_companion_means_no_crumb() {
        let app = crate::app::test_support::test_app(crate::app::test_support::default_bindings());
        assert_eq!(app.cloud_crumb(), None);
    }
}
