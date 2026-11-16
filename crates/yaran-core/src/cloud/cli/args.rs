//! Argument parsing for `yaran cloud` (hand-parsed, the `parse_server_args` precedent).
//!
//! Five verbs: `login`, `logout`, `status`, `rotate`, `pair-phone`. `--help` / `-h`
//! anywhere asks for that verb's help. Unknown verbs and flags are refused with a
//! sentence naming the help command.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! ```text
//! Uses: none
//! External: std
//!
//! Used by:
//! cloud/cli/args.rs
//! ├── cloud::cli
//! ├── cloud::cli::login
//! └── cloud::cli::manage
//! ```
//! <module-headers:end>

/// Which verb a help request is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    /// `yaran cloud login`.
    Login,
    /// `yaran cloud logout`.
    Logout,
    /// `yaran cloud status`.
    Status,
    /// `yaran cloud rotate`.
    Rotate,
    /// `yaran cloud pair-phone`.
    PairPhone,
}

impl Verb {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "login" => Some(Self::Login),
            "logout" => Some(Self::Logout),
            "status" => Some(Self::Status),
            "rotate" => Some(Self::Rotate),
            "pair-phone" => Some(Self::PairPhone),
            _ => None,
        }
    }
}

/// A parsed `yaran cloud` command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudCommand {
    /// Print help, for one verb or all of them.
    Help(Option<Verb>),
    /// Pair this machine.
    Login(LoginArgs),
    /// Disconnect this machine.
    Logout(LogoutArgs),
    /// Report the pairing and the tunnel.
    Status(StatusArgs),
    /// Rotate the tunnel token, or the consent key.
    Rotate(RotateArgs),
    /// Show the QR code a phone pairs with.
    PairPhone {
        /// The organization to pair the phone with.
        org: Option<String>,
    },
}

/// The options of `yaran cloud login`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoginArgs {
    /// The organization's address, when given.
    pub url: Option<String>,
    /// The machine name to ask for.
    pub name: Option<String>,
    /// Print the approval address instead of opening a browser.
    pub no_browser: bool,
}

/// The options of `yaran cloud logout`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LogoutArgs {
    /// Skip the confirmation.
    pub yes: bool,
    /// Forget the pairing here without telling the control plane.
    pub local_only: bool,
}

/// The options of `yaran cloud status`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatusArgs {
    /// Print JSON.
    pub json: bool,
    /// Report only what is on disk, asking nobody.
    pub offline: bool,
}

/// The options of `yaran cloud rotate`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RotateArgs {
    /// Skip the confirmation.
    pub yes: bool,
    /// Rotate the consent key instead of the tunnel token.
    pub consent_key: bool,
}

/// Parse the arguments after `yaran cloud`.
///
/// # Errors
///
/// Fails, with the sentence to print, on an unknown verb or option or a
/// missing value.
pub fn parse(args: &[String]) -> Result<CloudCommand, String> {
    let Some(first) = args.first() else {
        return Ok(CloudCommand::Help(None));
    };
    if matches!(first.as_str(), "--help" | "-h" | "help") {
        return Ok(CloudCommand::Help(None));
    }
    let verb = Verb::parse(first).ok_or_else(|| {
        format!(
            "`yaran cloud {}` is not a command; run `yaran cloud --help` for login, logout, status, rotate and pair-phone.",
            crate::sanitize::truncate(first, 40)
        )
    })?;
    let rest = &args[1..];
    if rest.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(CloudCommand::Help(Some(verb)));
    }
    let mut flags = Flags::default();
    let mut positional = Vec::new();
    let mut it = rest.iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value; see `yaran cloud {first} --help`."))
        };
        match (verb, arg.as_str()) {
            (Verb::Login, "--name") => flags.name = Some(value("--name")?),
            (Verb::Login, "--no-browser") => flags.switch(Switch::NoBrowser),
            (Verb::Logout | Verb::Rotate, "--yes" | "-y") => flags.switch(Switch::Yes),
            (Verb::Logout, "--local-only") => flags.switch(Switch::LocalOnly),
            (Verb::Status, "--json") => flags.switch(Switch::Json),
            (Verb::Status, "--offline") => flags.switch(Switch::Offline),
            (Verb::Rotate, "--consent-key") => flags.switch(Switch::ConsentKey),
            (Verb::PairPhone, "--org") => flags.org = Some(value("--org")?),
            (Verb::Login, a) if !a.starts_with('-') && positional.is_empty() => {
                positional.push(a.to_string());
            }
            (_, a) => {
                return Err(format!(
                    "`{}` is not an option of `yaran cloud {first}`; run `yaran cloud {first} --help`.",
                    crate::sanitize::truncate(a, 40)
                ));
            }
        }
    }
    Ok(match verb {
        Verb::Login => CloudCommand::Login(LoginArgs {
            url: positional.pop(),
            no_browser: flags.has(Switch::NoBrowser),
            name: flags.name,
        }),
        Verb::Logout => CloudCommand::Logout(LogoutArgs {
            yes: flags.has(Switch::Yes),
            local_only: flags.has(Switch::LocalOnly),
        }),
        Verb::Status => CloudCommand::Status(StatusArgs {
            json: flags.has(Switch::Json),
            offline: flags.has(Switch::Offline),
        }),
        Verb::Rotate => CloudCommand::Rotate(RotateArgs {
            yes: flags.has(Switch::Yes),
            consent_key: flags.has(Switch::ConsentKey),
        }),
        Verb::PairPhone => CloudCommand::PairPhone { org: flags.org },
    })
}

/// A flag that takes no value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Switch {
    NoBrowser,
    Yes,
    LocalOnly,
    Json,
    Offline,
    ConsentKey,
}

/// What the flags after the verb said.
#[derive(Default)]
struct Flags {
    name: Option<String>,
    switches: std::collections::BTreeSet<Switch>,
    org: Option<String>,
}

impl Flags {
    fn switch(&mut self, switch: Switch) {
        self.switches.insert(switch);
    }

    fn has(&self, switch: Switch) -> bool {
        self.switches.contains(&switch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<CloudCommand, String> {
        parse(
            &args
                .iter()
                .map(std::string::ToString::to_string)
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn every_verb_parses() {
        assert_eq!(p(&[]), Ok(CloudCommand::Help(None)));
        assert_eq!(p(&["--help"]), Ok(CloudCommand::Help(None)));
        assert_eq!(
            p(&["login", "-h"]),
            Ok(CloudCommand::Help(Some(Verb::Login)))
        );
        assert_eq!(
            p(&[
                "login",
                "https://c.example.com",
                "--name",
                "box",
                "--no-browser"
            ]),
            Ok(CloudCommand::Login(LoginArgs {
                url: Some("https://c.example.com".into()),
                name: Some("box".into()),
                no_browser: true
            }))
        );
        assert_eq!(
            p(&["logout", "--yes", "--local-only"]),
            Ok(CloudCommand::Logout(LogoutArgs {
                yes: true,
                local_only: true
            }))
        );
        assert_eq!(
            p(&["status", "--json", "--offline"]),
            Ok(CloudCommand::Status(StatusArgs {
                json: true,
                offline: true
            }))
        );
        assert_eq!(
            p(&["rotate", "--consent-key", "-y"]),
            Ok(CloudCommand::Rotate(RotateArgs {
                yes: true,
                consent_key: true
            }))
        );
        assert_eq!(
            p(&["pair-phone", "--org", "x"]),
            Ok(CloudCommand::PairPhone {
                org: Some("x".into())
            })
        );
    }

    #[test]
    fn unknown_verbs_and_flags_are_refused_with_the_help_command() {
        let err = p(&["logn"]).unwrap_err();
        assert!(err.contains("yaran cloud --help"), "{err}");
        let err = p(&["status", "--yes"]).unwrap_err();
        assert!(err.contains("yaran cloud status --help"), "{err}");
        let err = p(&["login", "--name"]).unwrap_err();
        assert!(err.contains("needs a value"), "{err}");
        assert!(p(&["login", "a", "b"]).is_err());
    }
}
