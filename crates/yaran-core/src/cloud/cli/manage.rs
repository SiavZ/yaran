//! `yaran cloud status`, `logout` and `rotate`.
//!
//! `status` reads the credentials (never printing a secret), the `[cloud]` mode and the
//! leg-state file, then asks the control plane (W5) unless `--offline`. `logout` sends
//! W8 and deletes the credentials on 202 or 410; a network failure refuses unless
//! `--local-only`, which never contacts the control plane. `rotate` sends W7
//! (`reason: user`); `rotate --consent-key` rewrites the D24 key locally, no network.
//!
//! - Destructive verbs confirm on a terminal and require `--yes` elsewhere.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/cli/manage.rs
//! ├── cloud::actions
//! ├── cloud::cli
//! ├── cloud::credentials
//! ├── cloud::outcome
//! └── cloud::status
//! External: std
//!
//! Used by:
//! cloud/cli/manage.rs
//! └── cloud::cli
//! <module-headers:end>

use std::io::{BufRead, Write};

use super::{CloudDeps, confirm, finish};
use crate::cloud::actions;
use crate::cloud::credentials;
use crate::cloud::outcome::CloudActionOutcome;
use crate::cloud::status::{StatusReport, gather};

pub(super) fn status(deps: &CloudDeps, json: bool, offline: bool, out: &mut dyn Write) -> i32 {
    let report = gather(
        &deps.paths,
        deps.config.mode(),
        (!offline).then_some(&deps.api),
    );
    print_status(&report, json, report.exit_code(), out)
}

fn print_status(r: &StatusReport, json: bool, code: i32, out: &mut dyn Write) -> i32 {
    if json {
        let _ = writeln!(
            out,
            "{}",
            serde_json::to_string_pretty(r).unwrap_or_default()
        );
        return code;
    }
    if let Some(e) = &r.error {
        let _ = writeln!(out, "{e}");
        return code;
    }
    if !r.paired {
        let _ = writeln!(out, "{}", CloudActionOutcome::NotPaired.report().message());
        let _ = writeln!(out, "[cloud] mode: {}", r.mode);
        return code;
    }
    let opt = |v: &Option<String>| v.clone().unwrap_or_default();
    let _ = writeln!(
        out,
        "Paired with {} ({})",
        opt(&r.org_name),
        opt(&r.org_url)
    );
    let _ = writeln!(out, "  hostname:      {}", opt(&r.hostname));
    let _ = writeln!(out, "  machine id:    {}", opt(&r.machine_id));
    let _ = writeln!(out, "  owner:         {}", opt(&r.owner_email));
    let _ = writeln!(
        out,
        "  origin port:   {}",
        r.origin_port.unwrap_or_default()
    );
    let _ = writeln!(
        out,
        "  token version: {}",
        r.token_version.unwrap_or_default()
    );
    let _ = writeln!(out, "  paired at:     {}", opt(&r.paired_at));
    if let Some(t) = &r.revoked_at {
        let _ = writeln!(out, "  revoked at:    {t}");
    }
    let _ = writeln!(out, "  [cloud] mode:  {}", r.mode);
    let leg = match &r.leg {
        Some(l) => format!("{} (pid {}, since {})", l.state, l.pid, l.since),
        None => "not running (no yaran is serving remote access)".into(),
    };
    let _ = writeln!(out, "  tunnel:        {leg}");
    let remote = match &r.remote {
        None => "not checked (--offline)".to_string(),
        Some(x) if x.revoked => {
            "this machine was revoked; run `yaran cloud logout` and log in again".into()
        }
        Some(x) if x.reachable => match (x.token_version, r.token_version) {
            (Some(remote), Some(local)) if remote > local => {
                format!(
                    "reachable; a newer tunnel token (version {remote}) exists, and a running yaran fetches it"
                )
            }
            _ => "reachable".into(),
        },
        Some(x) => format!("unreachable: {}", x.detail.clone().unwrap_or_default()),
    };
    let _ = writeln!(out, "  control plane: {remote}");
    code
}

pub(super) fn logout(
    deps: &CloudDeps,
    yes: bool,
    local_only: bool,
    mut stdin: Box<dyn BufRead + Send>,
    out: &mut dyn Write,
) -> i32 {
    let creds = match credentials::read(&deps.paths) {
        Ok(Some(c)) => Some(c),
        Ok(None) => return finish(&CloudActionOutcome::NotPaired, out),
        Err(e) if local_only => {
            let _ = writeln!(out, "{e}");
            None
        }
        Err(e) => {
            return finish(
                &CloudActionOutcome::CredentialsUnreadable {
                    reason: e.to_string(),
                },
                out,
            );
        }
    };
    let question = match &creds {
        Some(c) => format!(
            "Disconnect {} from {}? Phones lose access to it.",
            c.hostname, c.org_name
        ),
        None => "Forget this machine's unreadable cloud credentials?".to_string(),
    };
    if let Err(code) = confirm(deps, yes, &question, &mut *stdin, out) {
        return code;
    }
    let outcome = actions::logout(&deps.paths, &deps.api, local_only);
    let code = finish(&outcome, out);
    if !matches!(
        outcome,
        CloudActionOutcome::Unpaired { .. }
            | CloudActionOutcome::UnpairedLocallyOnly { .. }
            | CloudActionOutcome::NotPaired
    ) {
        let _ = writeln!(
            out,
            "The credentials were kept. Run `yaran cloud logout --local-only` to forget them anyway."
        );
        return code.max(1);
    }
    code
}

pub(super) fn rotate(
    deps: &CloudDeps,
    yes: bool,
    consent_key: bool,
    mut stdin: Box<dyn BufRead + Send>,
    out: &mut dyn Write,
) -> i32 {
    let creds = match credentials::read(&deps.paths) {
        Ok(Some(c)) => c,
        Ok(None) => return finish(&CloudActionOutcome::NotPaired, out),
        Err(e) => {
            return finish(
                &CloudActionOutcome::CredentialsUnreadable {
                    reason: e.to_string(),
                },
                out,
            );
        }
    };
    let question = if consent_key {
        format!(
            "Replace the phone consent key of {}? Every phone will see the consent page once more on it.",
            creds.hostname
        )
    } else {
        format!(
            "Rotate the tunnel token of {}? A running yaran reconnects.",
            creds.hostname
        )
    };
    if let Err(code) = confirm(deps, yes, &question, &mut *stdin, out) {
        return code;
    }
    let outcome = if consent_key {
        actions::rotate_consent_key(&deps.paths)
    } else {
        actions::rotate_token(&deps.paths, &deps.api)
    };
    finish(&outcome, out)
}
