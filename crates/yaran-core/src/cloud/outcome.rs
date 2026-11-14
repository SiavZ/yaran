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
//! ├── cloud::login
//! ├── cloud::login_session
//! ├── yaran-core[test cloud_login]
//! ├── yaran-tui::app::cloud_commands
//! ├── yaran-tui::app::cloud_render
//! ├── yaran-tui::app::cloud_tests
//! ├── yaran-web::cloud_routes
//! └── yaran-web::cloud_routes::actions_routes
//! <module-headers:end>

use crate::cloud::machine_api_error::MachineApiError;
use crate::engine::StatusUpdate;
use crate::status_text;
use crate::status_text::StatusText;
use crate::statusline::StatusTone;

pub const KEY_LOGIN: &str = "cloud-login";
pub const KEY_LOGOUT: &str = "cloud-logout";
pub const KEY_ROTATE: &str = "cloud-rotate";
pub const KEY_STATUS: &str = "cloud-status";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudActionOutcome {
    Paired {
        hostname: String,
        org_name: String,
    },
    AlreadyPairedElsewhere {
        org: String,
    },
    ProtocolUnsupported {
        min: i64,
        max: i64,
        ours: i64,
    },
    LoginTimedOut,
    LoginCancelled,
    /// Not an error: the surface shows the URL to open by hand.
    BrowserUnavailable {
        url: String,
    },
    ClaimRefused {
        code: String,
        message: String,
    },
    /// A refusal of a signed machine call other than the claim.
    Refused {
        code: String,
        message: String,
    },
    Unpaired {
        hostname: String,
    },
    /// Sticky warning: the token stays valid until an admin removes the machine.
    UnpairedLocallyOnly {
        hostname: String,
    },
    NotPaired,
    Rotated {
        hostname: String,
    },
    ConsentKeyRotated {
        hostname: String,
    },
    Revoked {
        hostname: String,
    },
    ClockSkew {
        server_time: Option<String>,
    },
    Network {
        detail: String,
    },
    CredentialsUnreadable {
        reason: String,
    },
    /// A typed org URL or machine name was refused before anything was sent.
    InvalidInput {
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
            | Self::AlreadyPairedElsewhere { .. } => StatusTone::Warning,
            Self::ProtocolUnsupported { .. }
            | Self::ClaimRefused { .. }
            | Self::Refused { .. }
            | Self::Revoked { .. }
            | Self::ClockSkew { .. }
            | Self::Network { .. }
            | Self::CredentialsUnreadable { .. }
            | Self::InvalidInput { .. } => StatusTone::Error,
        }
    }

    /// Whether the person must act outside the message (kept on screen).
    pub fn sticky(&self) -> bool {
        matches!(
            self,
            Self::UnpairedLocallyOnly { .. } | Self::Revoked { .. }
        )
    }

    /// Whether the CLI exits non-zero for this outcome.
    pub fn is_failure(&self) -> bool {
        matches!(self.tone(), StatusTone::Error | StatusTone::Warning)
            && !matches!(self, Self::UnpairedLocallyOnly { .. })
    }

    /// The one sentence for this outcome.
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
