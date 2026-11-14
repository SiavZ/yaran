//! Argument parsing for `yaran cloud` (hand-parsed, the `parse_server_args` precedent).
//!
//! Five verbs: `login`, `logout`, `status`, `rotate`, `pair-phone`. `--help` / `-h`
//! anywhere asks for that verb's help. Unknown verbs and flags are refused with a
//! sentence naming the help command.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! Uses: none
//! External: none
//!
//! Used by:
//! cloud/cli/args.rs
//! └── cloud::cli
//! <module-headers:end>

/// Which verb a help request is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Login,
    Logout,
    Status,
    Rotate,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudCommand {
    Help(Option<Verb>),
    Login {
        url: Option<String>,
        name: Option<String>,
        no_browser: bool,
    },
    Logout {
        yes: bool,
        local_only: bool,
    },
    Status {
        json: bool,
        offline: bool,
    },
    Rotate {
        yes: bool,
        consent_key: bool,
    },
    PairPhone {
        org: Option<String>,
    },
}

/// Parse the arguments after `yaran cloud`.
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
            (Verb::Login, "--no-browser") => flags.no_browser = true,
            (Verb::Logout | Verb::Rotate, "--yes" | "-y") => flags.yes = true,
            (Verb::Logout, "--local-only") => flags.local_only = true,
            (Verb::Status, "--json") => flags.json = true,
            (Verb::Status, "--offline") => flags.offline = true,
            (Verb::Rotate, "--consent-key") => flags.consent_key = true,
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
        Verb::Login => CloudCommand::Login {
            url: positional.pop(),
            name: flags.name,
            no_browser: flags.no_browser,
        },
        Verb::Logout => CloudCommand::Logout {
            yes: flags.yes,
            local_only: flags.local_only,
        },
        Verb::Status => CloudCommand::Status {
            json: flags.json,
            offline: flags.offline,
        },
        Verb::Rotate => CloudCommand::Rotate {
            yes: flags.yes,
            consent_key: flags.consent_key,
        },
        Verb::PairPhone => CloudCommand::PairPhone { org: flags.org },
    })
}

#[derive(Default)]
struct Flags {
    name: Option<String>,
    no_browser: bool,
    yes: bool,
    local_only: bool,
    json: bool,
    offline: bool,
    consent_key: bool,
    org: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(args: &[&str]) -> Result<CloudCommand, String> {
        parse(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>())
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
            Ok(CloudCommand::Login {
                url: Some("https://c.example.com".into()),
                name: Some("box".into()),
                no_browser: true
            })
        );
        assert_eq!(
            p(&["logout", "--yes", "--local-only"]),
            Ok(CloudCommand::Logout {
                yes: true,
                local_only: true
            })
        );
        assert_eq!(
            p(&["status", "--json", "--offline"]),
            Ok(CloudCommand::Status {
                json: true,
                offline: true
            })
        );
        assert_eq!(
            p(&["rotate", "--consent-key", "-y"]),
            Ok(CloudCommand::Rotate {
                yes: true,
                consent_key: true
            })
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
