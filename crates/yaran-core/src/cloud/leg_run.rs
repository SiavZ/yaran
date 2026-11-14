//! The cloud leg's run loop, on its supervisor thread: spawn cloudflared, watch it, and
//! restart, heal or stop it by the policy table.
//!
//! cloudflared never exits on an auth failure, so the loop watches for Unauthorized plus a
//! continuously unready `/ready` for the confirm window, then asks the control plane:
//! a 410 stops the leg as revoked; a newer `token_version` syncs the current token
//! (`rotate(Sync)`); an equal one mints a fresh token once (`rotate(User)`); Unauthorized
//! after that stops with an error. A network failure or clock skew keeps the child.
//!
//! - The token file is written before each spawn and removed when the leg ends.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_run.rs
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::child_registry
//! ├── cloud::cloudflared::command
//! ├── cloud::cloudflared::log_lines
//! ├── cloud::cloudflared::policy
//! ├── cloud::cloudflared::ready
//! ├── cloud::cloudflared::supervisor
//! ├── cloud::leg
//! ├── cloud::leg_identity
//! ├── cloud::leg_start
//! ├── cloud::leg_state
//! └── sanitize
//! External: chrono, rand, std, tracing
//!
//! Used by:
//! cloud/leg_run.rs
//! ├── cloud
//! └── cloud::leg
//! <module-headers:end>

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use rand::SeedableRng;

use super::cloudflared::acquire::BinaryUnavailable;
use super::cloudflared::child_registry::process_identity;
use super::cloudflared::command::{self, ChildSpec};
use super::cloudflared::log_lines::LogSignal;
use super::cloudflared::policy::{
    BinarySource, ChildExit, ExitAction, FailureNotice, FailureRun, RestartBackoff,
    UnauthorizedTracker, plan_after_exit,
};
use super::cloudflared::ready::{POLL_UNTIL_READY, POLL_WHILE_READY, Readiness};
use super::cloudflared::supervisor::{self, RunningChild};
use super::leg::{CloudLegEvent, LegParams, LegSink, LegStop, sleep_unless_stopped};
use super::leg_identity::{CloudIdentity, LegState, MachineApiError, PairedMachine, RotateReason};
use super::leg_start::{Prepared, acquire_binary, ensure_origin, load_machine};

const TICK: Duration = Duration::from_millis(100);

enum MonitorEnd {
    Stopped,
    Exited(ChildExit),
    /// A heal rotated the token: start again at once.
    Restart,
    Terminal(LegStop),
}

enum Heal {
    Rotated,
    Keep,
    Terminal(LegStop),
}

struct Run<'a> {
    params: &'a LegParams,
    identity: &'a dyn CloudIdentity,
    stop: &'a AtomicBool,
    sink: &'a LegSink,
    machine: PairedMachine,
    binary: PathBuf,
    source: BinarySource,
    token_file: PathBuf,
    failures: FailureRun,
    user_rotated: bool,
}

/// Run until the leg ends; answers why it ended.
pub fn run(
    params: &LegParams,
    identity: &dyn CloudIdentity,
    prepared: Prepared,
    stop: &AtomicBool,
    sink: &LegSink,
) -> Result<LegStop, LegStop> {
    let mut run = Run {
        params,
        identity,
        stop,
        sink,
        machine: prepared.machine,
        binary: prepared.binary,
        source: prepared.source,
        token_file: identity.cloud_paths().tunnel_token,
        failures: FailureRun::default(),
        user_rotated: false,
    };
    let end = run.supervise();
    command::remove_token_file(&run.token_file);
    Ok(end)
}

impl Run<'_> {
    fn grace(&self) -> Duration {
        let seconds = self
            .params
            .settings
            .grace_period_seconds
            .min(command::MAX_GRACE_SECONDS);
        Duration::from_secs(seconds + 2)
    }

    fn supervise(&mut self) -> LegStop {
        let backoff = RestartBackoff {
            initial_ms: self.params.settings.restart_backoff_initial_ms,
            max_ms: self.params.settings.restart_backoff_max_ms,
            jitter_ms: self.params.settings.restart_backoff_jitter_ms,
        };
        let mut rng = rand::rngs::SmallRng::from_entropy();
        loop {
            let exit = match self.spawn() {
                Ok(child) => self.monitor(child),
                Err(err) => MonitorEnd::Exited(ChildExit::SpawnFailed(err.kind())),
            };
            let exit = match exit {
                MonitorEnd::Stopped => return LegStop::Requested,
                MonitorEnd::Terminal(end) => return end,
                MonitorEnd::Restart => continue,
                MonitorEnd::Exited(exit) => exit,
            };
            tracing::info!(target: "yaran::cloud", ?exit, "cloudflared exited");
            match plan_after_exit(exit, self.source) {
                ExitAction::Done => return LegStop::Requested,
                ExitAction::StopUnavailable => {
                    return LegStop::BinaryUnavailable(BinaryUnavailable::Missing {
                        path: self.binary.display().to_string(),
                    });
                }
                ExitAction::Heal => match self.heal() {
                    Heal::Rotated => continue,
                    Heal::Terminal(end) => return end,
                    Heal::Keep => {}
                },
                ExitAction::Reverify => {
                    match acquire_binary(self.params, self.identity, self.stop, self.sink) {
                        Ok((binary, _)) => self.binary = binary,
                        Err(end) => return end,
                    }
                }
                ExitAction::Restart => {
                    if self.source == BinarySource::User && matches!(exit, ChildExit::Code(10 | 11))
                    {
                        (self.sink)(CloudLegEvent::Warning(
                            "the configured cloudflared tried to update itself despite \
                             --no-autoupdate; yaran restarted it. Update it yourself."
                                .into(),
                        ));
                    }
                }
            }
            let notice = self.failures.on_failure(Instant::now());
            let delay = backoff.delay(self.failures.attempt().saturating_sub(1), &mut rng);
            (self.sink)(CloudLegEvent::Restarting {
                attempt: self.failures.attempt(),
                delay,
                first: notice == FailureNotice::First,
                escalate: notice == FailureNotice::Escalate,
            });
            if sleep_unless_stopped(self.stop, delay) {
                return LegStop::Requested;
            }
        }
    }

    fn spawn(&mut self) -> std::io::Result<(RunningChild, u16)> {
        command::write_token_file(&self.token_file, &self.machine.tunnel_token)?;
        let port = command::resolve_metrics_port(self.params.settings.metrics_port)?;
        let spec = ChildSpec {
            binary: self.binary.clone(),
            metrics_port: port,
            loglevel: self.params.settings.cloudflared_loglevel.clone(),
            grace_seconds: self.params.settings.grace_period_seconds,
            management_diagnostics: self.params.settings.management_diagnostics,
            token_file: self.token_file.clone(),
        };
        let child = supervisor::spawn(&spec, &self.machine.tunnel_token)?;
        self.record(&child, port, "starting");
        (self.sink)(CloudLegEvent::Starting {
            token_version: self.machine.token_version,
        });
        Ok((child, port))
    }

    fn record(&self, child: &RunningChild, port: u16, state: &str) {
        let pid = child.pid();
        let record = LegState {
            schema: crate::cloud::leg_state::LEG_STATE_SCHEMA,
            pid,
            pgid: pid,
            binary: self.binary.display().to_string(),
            metrics_addr: format!("127.0.0.1:{port}"),
            state: state.to_string(),
            since: chrono::Utc::now().to_rfc3339(),
            child_start_time: process_identity(pid).map(|(_, t)| t).unwrap_or(0),
        };
        if let Err(err) = self.identity.write_leg_state(&record) {
            tracing::warn!(target: "yaran::cloud", %err, "could not write leg-state.json");
        }
    }

    fn monitor(&mut self, (mut child, port): (RunningChild, u16)) -> MonitorEnd {
        let window = Duration::from_secs(self.params.settings.unauthorized_confirm_seconds.max(1));
        let mut tracker = UnauthorizedTracker::new(window);
        let mut ready = false;
        let mut next_probe = Instant::now();
        loop {
            if self.stop.load(Ordering::SeqCst) {
                child.stop(self.grace());
                return MonitorEnd::Stopped;
            }
            if let Some(exit) = child.try_exit() {
                if ready {
                    (self.sink)(CloudLegEvent::NotReady);
                }
                return MonitorEnd::Exited(exit);
            }
            let now = Instant::now();
            if child.drain_signals().contains(&LogSignal::Unauthorized) {
                tracker.saw_unauthorized(now);
            }
            if now >= next_probe {
                match (self.params.probe)(port) {
                    Readiness::Ready { connections } => {
                        tracker.ready();
                        self.user_rotated = false;
                        if !ready {
                            ready = true;
                            self.failures.on_ready(now);
                            self.record(&child, port, "ready");
                            (self.sink)(CloudLegEvent::Ready { connections });
                        }
                    }
                    Readiness::NotReady | Readiness::Unreachable => {
                        if ready {
                            ready = false;
                            self.failures.on_not_ready(now);
                            self.record(&child, port, "reconnecting");
                            (self.sink)(CloudLegEvent::NotReady);
                        }
                    }
                }
                next_probe = now
                    + if ready {
                        POLL_WHILE_READY
                    } else {
                        POLL_UNTIL_READY
                    };
            }
            if !ready && tracker.take_due(now) {
                match self.heal() {
                    Heal::Keep => {}
                    Heal::Rotated => {
                        child.stop(self.grace());
                        return MonitorEnd::Restart;
                    }
                    Heal::Terminal(end) => {
                        child.stop(self.grace());
                        return MonitorEnd::Terminal(end);
                    }
                }
            }
            std::thread::sleep(TICK);
        }
    }

    /// Ask the control plane what an Unauthorized (or exit 255) means, and act on it.
    fn heal(&mut self) -> Heal {
        (self.sink)(CloudLegEvent::Healing);
        let hostname = self.machine.hostname.clone();
        let config = match self.identity.machine_config() {
            Ok(config) => config,
            Err(err) => return self.heal_error(err),
        };
        let serving = self.params.serving_port;
        let worker_port = u16::try_from(config.origin_port).unwrap_or(0);
        if worker_port != serving {
            // The Worker is authoritative after an admin's repair: re-send ours (W32).
            let as_worker_sees_it = PairedMachine {
                origin_port: worker_port,
                ..self.machine.clone()
            };
            match ensure_origin(self.identity, as_worker_sees_it, serving) {
                Ok(machine) => self.machine = machine,
                Err(end) => return Heal::Terminal(end),
            }
        }
        let reason = if config.tunnel.token_version > self.machine.token_version {
            RotateReason::Sync
        } else if self.user_rotated {
            return Heal::Terminal(LegStop::HealFailed { hostname });
        } else {
            RotateReason::User
        };
        if let Err(err) = self.identity.rotate(reason) {
            return self.heal_error(err);
        }
        match load_machine(self.identity) {
            Ok(machine) => {
                self.machine = machine;
                self.user_rotated |= reason == RotateReason::User;
                Heal::Rotated
            }
            Err(end) => Heal::Terminal(end),
        }
    }

    fn heal_error(&self, err: MachineApiError) -> Heal {
        let warning = match err {
            MachineApiError::Revoked => {
                return Heal::Terminal(LegStop::Revoked {
                    hostname: self.machine.hostname.clone(),
                });
            }
            MachineApiError::ClockSkew { server_time } => clock_warning(server_time.as_deref()),
            other => format!(
                "Cloudflare keeps refusing the tunnel for {}, and yaran could not ask Yaran Cloud \
                 why ({}); cloudflared keeps running and yaran asks again shortly.",
                self.machine.hostname,
                describe(&other)
            ),
        };
        (self.sink)(CloudLegEvent::Warning(warning));
        Heal::Keep
    }
}

/// "this machine's clock is off by N s; fix the system clock" (02 §7 `signature_expired`).
pub fn clock_warning(server_time: Option<&str>) -> String {
    let offset = server_time
        .ok_or(())
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).map_err(|_| ()))
        .map(|server| (chrono::Utc::now() - server.with_timezone(&chrono::Utc)).num_seconds());
    match offset {
        Ok(seconds) => format!(
            "Yaran Cloud refused this machine's signed request because its clock is off by {}s; \
             fix the system clock. cloudflared keeps running.",
            seconds.abs()
        ),
        Err(_) => "Yaran Cloud refused this machine's signed request because its clock is off; \
                   fix the system clock. cloudflared keeps running."
            .to_string(),
    }
}

fn describe(err: &MachineApiError) -> String {
    let text = err.to_string();
    crate::sanitize::for_terminal(&text)
        .chars()
        .take(200)
        .collect()
}
