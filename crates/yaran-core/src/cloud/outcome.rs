//! Every way a Yaran Cloud action can end, and the one sentence each surface shows.
//!
//! The CLI, the TUI palette commands and the web dialog all report through
//! `CloudActionOutcome::report`, so the words cannot drift between surfaces. Names
//! (org, hostname, command) are chips through `status_text!`'s `q(..)`; the TUI prints
//! the plain spelling and the web gets the segments.
//!
//! - Pure; the status keys are the constants below, one per action.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/outcome.rs
//! ├── cloud::machine_api_error
//! ├── engine
//! ├── status_text
//! └── statusline
//! External: chrono
//!
//! Used by:
//! cloud/outcome.rs
//! ├── cloud
//! ├── cloud::actions
//! ├── cloud::cli
//! ├── cloud::cli::login
//! ├── cloud::cli::manage
//! ├── cloud::leg_outcome
//! ├── cloud::login
//! ├── cloud::login_session
//! ├── yaran-core[test cloud_login]
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_render
//! ├── yaran-tui::app::cloud_tests
//! ├── yaran-web::cloud_routes
//! └── yaran-web::cloud_routes::actions_routes
//! ```
//! <module-headers:end>

use crate::cloud::machine_api_error::MachineApiError;
use crate::engine::StatusUpdate;
use crate::status_text;
use crate::status_text::StatusText;
use crate::statusline::StatusTone;

/// The status key a Yaran Cloud login answers on.
pub const KEY_LOGIN: &str = "cloud-login";
/// The status key a disconnect answers on.
pub const KEY_LOGOUT: &str = "cloud-logout";
/// The status key a token rotation answers on.
pub const KEY_ROTATE: &str = "cloud-rotate";
/// The status key a status check answers on.
pub const KEY_STATUS: &str = "cloud-status";

/// The keyed busy a Yaran Cloud action shows under its fixed `key` while it runs.
///
/// The cloud actions answer on fixed keys that both surfaces share (a login a
/// browser started can end on the terminal UI's line), so their busy cannot
/// come from a `status_op`, which mints a key of its own. The pairing a
/// `status_op` enforces is the caller's here: register `key` as live first,
/// and always end it with the action's own final on the same key.
pub fn busy_status(key: &str, text: impl Into<StatusText>) -> StatusUpdate {
    StatusUpdate::busy(text).with_key(key)
}

/// How a Yaran Cloud action ended, as both surfaces report it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudActionOutcome {
    /// The machine is paired.
    Paired {
        /// The machine's hostname.
        hostname: String,
        /// The organization it is paired with.
        org_name: String,
    },
    /// The machine is already paired with another organization.
    AlreadyPairedElsewhere {
        /// That organization.
        org: String,
    },
    /// The control plane speaks no protocol version this yaran does.
    ProtocolUnsupported {
        /// The oldest version it speaks.
        min: i64,
        /// The newest version it speaks.
        max: i64,
        /// The version this yaran speaks.
        ours: i64,
    },
    /// Nobody approved the login in time.
    LoginTimedOut,
    /// The login was cancelled.
    LoginCancelled,
    /// Another login or a disconnect changed the pairing while this action ran; the
    /// newer state was kept.
    PairingChanged,
    /// The newer pairing was kept; `cleanup_started` records an acknowledged teardown
    /// request for the discarded claim. Any machine it replaced is still torn down.
    LoginSuperseded {
        /// Whether the control plane confirmed it is removing the discarded claim.
        cleanup_started: bool,
    },
    /// The claim succeeded but could not be persisted; its replacement effects remain.
    LoginNotStored {
        /// Why the credentials could not be written.
        reason: String,
        /// Whether the control plane confirmed it is removing the claim.
        cleanup_started: bool,
    },
    /// Not an error: the surface shows the URL to open by hand.
    BrowserUnavailable {
        /// The address to open by hand.
        url: String,
    },
    /// The control plane refused the claim.
    ClaimRefused {
        /// Its error code.
        code: String,
        /// Its message.
        message: String,
    },
    /// A refusal of a signed machine call other than the claim.
    Refused {
        /// Its error code.
        code: String,
        /// Its message.
        message: String,
    },
    /// The machine was disconnected.
    Unpaired {
        /// The hostname it had.
        hostname: String,
    },
    /// Sticky warning: the token stays valid until an admin removes the machine.
    UnpairedLocallyOnly {
        /// The hostname it had.
        hostname: String,
    },
    /// The machine is not paired, so there was nothing to do.
    NotPaired,
    /// The tunnel token was rotated.
    Rotated {
        /// The machine's hostname.
        hostname: String,
    },
    /// The consent key was rotated, so every remembered phone asks again.
    ConsentKeyRotated {
        /// The machine's hostname.
        hostname: String,
    },
    /// The control plane says this machine is no longer paired.
    Revoked {
        /// The hostname it had.
        hostname: String,
    },
    /// This machine's clock is too far from the control plane's.
    ClockSkew {
        /// The control plane's time, when it said.
        server_time: Option<String>,
    },
    /// The control plane could not be reached, or answered badly.
    Network {
        /// What went wrong.
        detail: String,
    },
    /// The cloud credentials file could not be read.
    CredentialsUnreadable {
        /// Why.
        reason: String,
    },
    /// A typed org URL or machine name was refused before anything was sent.
    InvalidInput {
        /// Why.
        reason: String,
    },
}

impl CloudActionOutcome {
    /// The outcome of a failed control-plane call made for `hostname` (empty when
    /// unknown, as during login).
    pub fn from_api_error(err: MachineApiError, hostname: &str) -> Self {
        match err {
            MachineApiError::Revoked => Self::Revoked {
                hostname: hostname.to_string(),
            },
            MachineApiError::ProtocolUnsupported { min, max, ours } => {
                Self::ProtocolUnsupported { min, max, ours }
            }
            MachineApiError::ClockSkew { server_time } => Self::ClockSkew { server_time },
            MachineApiError::Refused { code, message, .. } => Self::Refused { code, message },
            MachineApiError::Server { .. }
            | MachineApiError::Network(_)
            | MachineApiError::Malformed(_) => Self::Network {
                detail: err.to_string(),
            },
            MachineApiError::NotPaired => Self::NotPaired,
            MachineApiError::Credentials(e) => Self::CredentialsUnreadable {
                reason: e.to_string(),
            },
        }
    }

    /// The tone the outcome is reported in.
    pub fn tone(&self) -> StatusTone {
        match self {
            Self::Paired { .. }
            | Self::Unpaired { .. }
            | Self::Rotated { .. }
            | Self::ConsentKeyRotated { .. }
            | Self::NotPaired
            | Self::BrowserUnavailable { .. }
            | Self::LoginCancelled => StatusTone::Info,
            Self::UnpairedLocallyOnly { .. }
            | Self::LoginTimedOut
            | Self::PairingChanged
            | Self::LoginSuperseded { .. }
            | Self::AlreadyPairedElsewhere { .. } => StatusTone::Warning,
            Self::ProtocolUnsupported { .. }
            | Self::ClaimRefused { .. }
            | Self::Refused { .. }
            | Self::Revoked { .. }
            | Self::ClockSkew { .. }
            | Self::Network { .. }
            | Self::CredentialsUnreadable { .. }
            | Self::LoginNotStored { .. }
            | Self::InvalidInput { .. } => StatusTone::Error,
        }
    }

    /// Whether the person must act outside the message (kept on screen).
    pub fn sticky(&self) -> bool {
        matches!(
            self,
            Self::UnpairedLocallyOnly { .. }
                | Self::Revoked { .. }
                | Self::LoginSuperseded {
                    cleanup_started: false
                }
                | Self::LoginNotStored {
                    cleanup_started: false,
                    ..
                }
        )
    }

    /// Whether the CLI exits non-zero for this outcome.
    pub fn is_failure(&self) -> bool {
        matches!(self.tone(), StatusTone::Error | StatusTone::Warning)
            && !matches!(self, Self::UnpairedLocallyOnly { .. })
    }

    /// The one sentence for this outcome.
    #[expect(
        clippy::too_many_lines,
        reason = "one sentence per outcome, kept in one match so none is missed"
    )]
    pub fn report(&self) -> StatusText {
        let login = "yaran cloud login";
        let logout = "yaran cloud logout";
        match self {
            Self::Paired { hostname, org_name } => status_text!(
                "This machine is paired with ",
                q(org_name),
                " as ",
                q(hostname),
                ". Remote access starts the next time yaran serves (it follows the [cloud] mode setting)."
            ),
            Self::AlreadyPairedElsewhere { org } => status_text!(
                "This machine is already paired with ",
                q(org),
                ". Run ",
                q(logout),
                " first, then log in to the other organization."
            ),
            Self::ProtocolUnsupported { min, max, ours } => {
                let side = if *min > *ours {
                    "update yaran"
                } else {
                    "ask your administrator to update the control plane"
                };
                status_text!(format!(
                    "The control plane speaks protocol versions {min} to {max} and this yaran speaks {ours}; {side}."
                ))
            }
            Self::LoginTimedOut => status_text!(
                "The login timed out before the browser finished; run ",
                q(login),
                " again when you are ready."
            ),
            Self::LoginCancelled => status_text!("The login was cancelled; nothing was changed."),
            Self::PairingChanged => status_text!(
                "This machine's Yaran Cloud pairing changed while that was running (another login or disconnect finished first), so the newer pairing was kept. Run ",
                q("yaran cloud status"),
                " to see it."
            ),
            Self::LoginSuperseded { cleanup_started } => status_text!(
                "Another login or disconnect changed this machine's Yaran Cloud pairing while this login was finishing, so the newer state was kept. ",
                if *cleanup_started {
                    CLAIM_REMOVED
                } else {
                    CLAIM_NOT_CONFIRMED
                },
                " If you chose Replace on the confirm page, the replaced machine is being disconnected anyway; run ",
                q("yaran cloud status"),
                ", and run ",
                q(login),
                " again if it says the pairing was revoked."
            ),
            Self::LoginNotStored {
                reason,
                cleanup_started,
            } => status_text!(
                "The control plane accepted this login, but yaran could not save its credentials: ",
                reason.as_str(),
                ". ",
                if *cleanup_started {
                    CLAIM_REMOVED
                } else {
                    CLAIM_NOT_CONFIRMED
                },
                " If you chose Replace on the confirm page, the replaced machine is being disconnected anyway. Run ",
                q("yaran cloud status"),
                " to check this machine, fix the credentials problem, then run ",
                q(login),
                " again."
            ),
            Self::BrowserUnavailable { url } => status_text!(
                "yaran could not open a browser here. Open ",
                q(url),
                " on any device and approve this machine; yaran is still waiting."
            ),
            Self::ClaimRefused { code, message } => status_text!(
                "The control plane refused to pair this machine: ",
                message.as_str(),
                " (",
                q(code),
                "). Nothing was saved."
            ),
            Self::Refused { code, message } => status_text!(
                "The control plane refused the request: ",
                message.as_str(),
                " (",
                q(code),
                ")."
            ),
            Self::Unpaired { hostname } => status_text!(
                "This machine is no longer paired; ",
                q(hostname),
                " is being removed and its credentials were deleted here."
            ),
            Self::UnpairedLocallyOnly { hostname } => status_text!(
                "This machine forgot its credentials, but the control plane was not told: ",
                q(hostname),
                "'s tunnel token stays valid until an administrator removes the machine. Ask them to remove it now."
            ),
            Self::NotPaired => status_text!(
                "This machine is not paired with Yaran Cloud; run ",
                q(login),
                " to pair it."
            ),
            Self::Rotated { hostname } => status_text!(
                "The tunnel token for ",
                q(hostname),
                " was rotated; a running yaran reconnects with the new one by itself."
            ),
            Self::ConsentKeyRotated { hostname } => status_text!(
                "Phones will be asked to confirm again the next time they sign in to ",
                q(hostname),
                "."
            ),
            Self::Revoked { hostname } if hostname.is_empty() => status_text!(
                "The control plane says this machine was revoked. Run ",
                q(logout),
                " and log in again to reconnect it."
            ),
            Self::Revoked { hostname } => status_text!(
                "The control plane says ",
                q(hostname),
                " was revoked. Run ",
                q(logout),
                " and log in again to reconnect it."
            ),
            Self::ClockSkew { server_time } => {
                let detail = server_time
                    .as_deref()
                    .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                    .map(|t| {
                        let offset = chrono::Utc::now().signed_duration_since(t).num_seconds();
                        format!(
                            " (the server time is {}, this clock is {offset:+} s off)",
                            t.format("%Y-%m-%dT%H:%M:%SZ")
                        )
                    })
                    .unwrap_or_default();
                status_text!(format!(
                    "The control plane rejected the request because this machine's clock is wrong{detail}; fix the system clock and try again."
                ))
            }
            Self::Network { detail } => status_text!(format!(
                "Yaran Cloud could not be reached: {detail}. Check the network and try again."
            )),
            Self::CredentialsUnreadable { reason } | Self::InvalidInput { reason } => {
                status_text!(reason.as_str())
            }
        }
    }

    /// The keyed final status for `key`.
    pub fn to_status(&self, key: &str) -> StatusUpdate {
        let update = StatusUpdate::keyed(key, self.tone(), self.report());
        if self.sticky() {
            update.sticky()
        } else {
            update
        }
    }
}

/// What became of a discarded claim, when the control plane confirmed its removal.
const CLAIM_REMOVED: &str = "The control plane is removing this login's new pairing.";
/// The same, when it did not.
const CLAIM_NOT_CONFIRMED: &str = "The control plane did not confirm removal of this login's new pairing. Ask an administrator to check and remove it if it is still listed.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_chips_and_the_plain_spelling_quotes_them() {
        let out = CloudActionOutcome::Paired {
            hostname: "laptop-sam.example.com".into(),
            org_name: "Example".into(),
        }
        .report();
        let segments = out.segments().expect("chips");
        assert!(segments.len() >= 4);
        assert!(out.message().contains("laptop-sam.example.com"));
        let rotated = CloudActionOutcome::ConsentKeyRotated {
            hostname: "h.example.com".into(),
        };
        assert!(
            rotated
                .report()
                .message()
                .starts_with("Phones will be asked to confirm again")
        );
        assert_eq!(rotated.tone(), StatusTone::Info);
    }

    #[test]
    fn local_only_logout_is_a_sticky_warning() {
        let o = CloudActionOutcome::UnpairedLocallyOnly {
            hostname: "h".into(),
        };
        assert_eq!(o.tone(), StatusTone::Warning);
        assert!(o.sticky() && !o.is_failure());
        assert!(o.to_status(KEY_LOGOUT).sticky);
    }

    #[test]
    fn api_errors_map_to_outcomes() {
        assert_eq!(
            CloudActionOutcome::from_api_error(MachineApiError::Revoked, "h"),
            CloudActionOutcome::Revoked {
                hostname: "h".into()
            }
        );
        assert_eq!(
            CloudActionOutcome::from_api_error(MachineApiError::NotPaired, ""),
            CloudActionOutcome::NotPaired
        );
        let skew = CloudActionOutcome::from_api_error(
            MachineApiError::ClockSkew {
                server_time: Some("2020-01-01T00:00:00Z".into()),
            },
            "",
        );
        assert!(skew.report().message().contains("2020-01-01T00:00:00Z"));
        assert!(skew.report().message().contains(" s off"));
    }
}
