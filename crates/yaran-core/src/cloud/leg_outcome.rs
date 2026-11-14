//! One sentence per cloud-leg outcome, built once here and shown by every surface.
//!
//! `CloudModeOutcome::report` answers a mode change on the `cloud-mode` key; becoming
//! ready and every later transition are reported separately on `cloud-leg` (a mode reply
//! must not wait out a download), and the download itself on `cloud-cloudflared`.
//! Hostnames, emails and commands are chips (`status_text!`'s `q(..)`).
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_outcome.rs
//! ├── cloud::leg
//! ├── cloud::leg_outcome::tests
//! ├── cloud::leg_seam
//! ├── engine
//! ├── status_text
//! └── statusline
//! External: none
//!
//! Used by:
//! cloud/leg_outcome.rs
//! ├── cloud
//! └── cloud::leg_outcome::tests
//! <module-headers:end>

use super::leg::{CloudLegEvent, LegStop};
use super::leg_seam::CloudMode;
use crate::engine::StatusUpdate;
use crate::status_text::StatusText;
use crate::statusline::StatusTone;

pub const CLOUD_MODE_KEY: &str = "cloud-mode";
pub const CLOUD_LEG_KEY: &str = "cloud-leg";
pub const CLOUD_CLOUDFLARED_KEY: &str = "cloud-cloudflared";

/// What a live `[cloud] mode` change did. Exhaustive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudModeOutcome {
    /// The leg is starting; readiness is reported later on `cloud-leg`.
    Starting {
        hostname: String,
    },
    AlreadyRunning {
        hostname: String,
    },
    Stopped,
    NotPaired,
    Revoked {
        hostname: String,
    },
    /// Nothing is serving: the choice is saved and applies when a listener starts.
    NotServing,
    /// The serve loop did not answer in time.
    TimedOut,
}

/// One outcome rendered for a status line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudModeReport {
    pub warning: bool,
    pub sticky: bool,
    pub message: StatusText,
}

impl CloudModeOutcome {
    pub fn report(&self, mode: CloudMode) -> CloudModeReport {
        let saved = format!("[cloud] mode is saved as \"{}\". ", mode.as_str());
        let info = |message: StatusText| CloudModeReport {
            warning: false,
            sticky: false,
            message,
        };
        match self {
            Self::Starting { hostname } => info(crate::status_text![
                saved,
                "yaran is starting remote access for ",
                q(hostname),
                " and says so when the tunnel is live."
            ]),
            Self::AlreadyRunning { hostname } => info(crate::status_text![
                saved,
                "Remote access for ",
                q(hostname),
                " was already running and is unchanged."
            ]),
            Self::Stopped => info(
                format!("{saved}Remote access is off; the tunnel has been stopped and this machine stays paired.")
                    .into(),
            ),
            Self::NotPaired => CloudModeReport {
                warning: mode.warns_when_unpaired(),
                sticky: mode.warns_when_unpaired(),
                message: crate::status_text![
                    saved,
                    "This machine is not paired with Yaran Cloud, so there is no tunnel to run; run ",
                    q("yaran cloud login"),
                    " to pair it."
                ],
            },
            Self::Revoked { hostname } => CloudModeReport {
                warning: true,
                sticky: true,
                message: revoked_sentence(hostname),
            },
            Self::NotServing => info(
                format!("{saved}Nothing is serving, so it applies when a listener starts.").into(),
            ),
            Self::TimedOut => CloudModeReport {
                warning: true,
                sticky: false,
                message: format!(
                    "{saved}The server did not report back in time, so yaran cannot say what \
                     the tunnel is doing; check yaran.log."
                )
                .into(),
            },
        }
    }

    /// The keyed status for this report.
    pub fn status(&self, mode: CloudMode) -> StatusUpdate {
        let report = self.report(mode);
        let tone = if report.warning {
            StatusTone::Warning
        } else {
            StatusTone::Info
        };
        let update = StatusUpdate::keyed(CLOUD_MODE_KEY, tone, report.message);
        if report.sticky {
            update.sticky()
        } else {
            update
        }
    }
}

fn revoked_sentence(hostname: &str) -> StatusText {
    crate::status_text![
        "Yaran Cloud revoked ",
        q(hostname),
        "; remote access is off. Run ",
        q("yaran cloud login"),
        " to pair again."
    ]
}

/// The sentence `yaran server` prints once, on the first Ready of a run (D17).
pub fn tls_disclosure(hostname: &str) -> String {
    format!("Cloudflare terminates TLS for {hostname} and can see this traffic.")
}

/// What a leg event says on `cloud-leg` / `cloud-cloudflared`, if anything.
/// `owner` is the Access owner email; `mode` decides whether failures stick.
pub fn leg_status(
    event: &CloudLegEvent,
    hostname: &str,
    owner: &str,
    mode: CloudMode,
) -> Option<StatusUpdate> {
    let leg = |tone, text: StatusText| Some(StatusUpdate::keyed(CLOUD_LEG_KEY, tone, text));
    let sticky_if_yes = |update: StatusUpdate| {
        if mode.warns_when_unpaired() {
            update.sticky()
        } else {
            update
        }
    };
    match event {
        CloudLegEvent::Acquiring { pct, total_mb } => {
            let size = total_mb.map(|mb| format!(" ({mb} MB)")).unwrap_or_default();
            let pct = pct.map(|p| format!(": {p}%")).unwrap_or_default();
            Some(StatusUpdate::keyed(
                CLOUD_CLOUDFLARED_KEY,
                StatusTone::Busy,
                format!(
                    "Downloading cloudflared {}{size}{pct}",
                    super::cloudflared::pins::PINNED_VERSION
                ),
            ))
        }
        CloudLegEvent::Acquired { version } => Some(StatusUpdate::keyed(
            CLOUD_CLOUDFLARED_KEY,
            StatusTone::Info,
            format!("Downloaded cloudflared {version} and verified both of its pinned checksums."),
        )),
        CloudLegEvent::Ready { .. } => leg(
            StatusTone::Info,
            crate::status_text![
                "Remote access is live at ",
                q(hostname),
                ", protected by Cloudflare Access for ",
                q(owner),
                "."
            ],
        ),
        CloudLegEvent::NotReady => leg(
            StatusTone::Warning,
            crate::status_text![
                "Remote access to ",
                q(hostname),
                " dropped; cloudflared is reconnecting by itself."
            ],
        ),
        CloudLegEvent::Restarting {
            attempt,
            delay,
            first,
            escalate,
        } => {
            if *escalate {
                leg(
                    StatusTone::Warning,
                    crate::status_text![
                        "cloudflared for ",
                        q(hostname),
                        format!(
                            " has failed {attempt} times without connecting; yaran keeps \
                             restarting it, but check yaran.log for the cause."
                        )
                    ],
                )
                .map(StatusUpdate::sticky)
            } else if *first {
                leg(
                    StatusTone::Warning,
                    crate::status_text![
                        "cloudflared for ",
                        q(hostname),
                        format!(" exited; yaran restarts it in {}s.", delay.as_secs().max(1))
                    ],
                )
            } else {
                None
            }
        }
        CloudLegEvent::Warning(text) => leg(StatusTone::Warning, text.clone().into()),
        CloudLegEvent::Starting { .. } | CloudLegEvent::Healing => None,
        CloudLegEvent::Stopped(stop) => stop_status(stop, hostname).map(sticky_if_yes),
    }
}

fn stop_status(stop: &LegStop, hostname: &str) -> Option<StatusUpdate> {
    let leg = |tone, text: StatusText| Some(StatusUpdate::keyed(CLOUD_LEG_KEY, tone, text));
    match stop {
        LegStop::Requested => None,
        LegStop::CredentialsGone => leg(
            StatusTone::Info,
            "This machine is no longer paired with Yaran Cloud, so remote access is off."
                .to_string()
                .into(),
        ),
        LegStop::Revoked { hostname } => {
            leg(StatusTone::Warning, revoked_sentence(hostname)).map(StatusUpdate::sticky)
        }
        LegStop::BinaryUnavailable(reason) => leg(
            StatusTone::Warning,
            format!("Remote access is off: {reason}.").into(),
        ),
        LegStop::NoLoopbackPrimary { port } => leg(
            StatusTone::Warning,
            format!(
                "Remote access is off: nothing answers on 127.0.0.1:{port}, the loopback address \
                 the tunnel forwards to; serve on loopback (the default [server] host) and choose \
                 the mode again."
            )
            .into(),
        ),
        LegStop::OriginPortMismatch { paired, serving } => leg(
            StatusTone::Warning,
            crate::status_text![
                format!(
                    "Remote access is off: this machine was paired for port {paired}, yaran is \
                     serving on {serving}, and Yaran Cloud could not be told; set "
                ),
                q(format!("[server] port = {paired}")),
                " or check your network."
            ],
        ),
        LegStop::HealFailed { .. } => leg(
            StatusTone::Error,
            crate::status_text![
                "Cloudflare still refuses the tunnel for ",
                q(hostname),
                " after yaran fetched a fresh token from Yaran Cloud, so remote access is off; \
                 check the machine in your Yaran Cloud admin console."
            ],
        ),
    }
}

#[cfg(test)]
#[path = "leg_outcome_tests.rs"]
mod tests;
