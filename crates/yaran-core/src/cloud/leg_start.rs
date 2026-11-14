//! The cloud leg's start sequence, on its supervisor thread: reap a stale child, load
//! the credentials, check the loopback origin and the paired origin port (W32), and get a
//! binary that is safe to run.
//!
//! - Every step answers a terminal [`LegStop`] on failure; nothing is spawned until all of
//!   them pass. A stop requested mid-way answers `Requested`.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_start.rs
//! ├── cloud::cloudflared
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::child_registry
//! ├── cloud::cloudflared::pins
//! ├── cloud::cloudflared::policy
//! ├── cloud::cloudflared::version
//! ├── cloud::leg
//! └── cloud::leg_identity
//! External: chrono, std, tracing
//!
//! Used by:
//! cloud/leg_start.rs
//! ├── cloud
//! ├── cloud::leg
//! └── cloud::leg_run
//! <module-headers:end>

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::cloudflared::acquire::{self, BinaryUnavailable};
use super::cloudflared::child_registry::{StaleChild, reap_stale};
use super::cloudflared::policy::BinarySource;
use super::cloudflared::{pin_for, pins, version};
use super::leg::{CloudLegEvent, LegParams, LegSink, LegStop};
use super::leg_identity::{CloudIdentity, MachineApiError, PairedMachine};

/// What a successful start sequence hands the run loop.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub binary: PathBuf,
    pub source: BinarySource,
    pub machine: PairedMachine,
}

const LOOPBACK_PROBE: Duration = Duration::from_millis(100);

fn stopped(stop: &AtomicBool) -> Result<(), LegStop> {
    if stop.load(Ordering::SeqCst) {
        Err(LegStop::Requested)
    } else {
        Ok(())
    }
}

pub fn prepare(
    params: &LegParams,
    identity: &dyn CloudIdentity,
    stop: &AtomicBool,
    sink: &LegSink,
) -> Result<Prepared, LegStop> {
    reap_recorded_child(identity, params.settings.grace_period_seconds);
    let machine = load_machine(identity)?;
    stopped(stop)?;
    check_loopback(params.serving_port)?;
    let machine = ensure_origin(identity, machine, params.serving_port)?;
    stopped(stop)?;
    let (binary, source) = acquire_binary(params, identity, stop, sink)?;
    stopped(stop)?;
    Ok(Prepared {
        binary,
        source,
        machine,
    })
}

/// A child a previous yaran left running (it was SIGKILLed): kill it only if its pid
/// still runs the recorded binary with the recorded start time.
fn reap_recorded_child(identity: &dyn CloudIdentity, grace_seconds: u64) {
    let Some(record) = identity.read_leg_state() else {
        return;
    };
    let stale = StaleChild {
        pid: record.pid,
        pgid: record.pgid,
        exe: std::path::Path::new(&record.binary),
        start_time: record.child_start_time,
    };
    if reap_stale(&stale, Duration::from_secs(grace_seconds.saturating_add(2))) {
        tracing::warn!(target: "yaran::cloud", pid = record.pid, "stopped a cloudflared left running by a previous yaran");
    }
    identity.clear_leg_state();
}

/// The credentials, or why there are none to run on.
pub(crate) fn load_machine(identity: &dyn CloudIdentity) -> Result<PairedMachine, LegStop> {
    match identity.load() {
        Ok(Some(machine)) if machine.revoked || identity.revoked() => Err(LegStop::Revoked {
            hostname: machine.hostname,
        }),
        Ok(Some(machine)) => Ok(machine),
        Ok(None) => Err(LegStop::CredentialsGone),
        Err(reason) => {
            tracing::warn!(target: "yaran::cloud", reason = %crate::sanitize::for_terminal(&reason), "the cloud credentials could not be read");
            Err(LegStop::CredentialsGone)
        }
    }
}

/// A 100 ms connect to `127.0.0.1:<port>`: an empirical check that also settles a `[::]`
/// dual-stack listener.
fn check_loopback(port: u16) -> Result<(), LegStop> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, LOOPBACK_PROBE)
        .map(drop)
        .map_err(|_| LegStop::NoLoopbackPrimary { port })
}

/// Before every start: when yaran serves on a port other than the paired one, tell the
/// control plane (signed W32) and carry on with the rewritten credentials.
pub(crate) fn ensure_origin(
    identity: &dyn CloudIdentity,
    machine: PairedMachine,
    serving: u16,
) -> Result<PairedMachine, LegStop> {
    if machine.origin_port == serving {
        return Ok(machine);
    }
    match identity.set_origin(serving) {
        Ok(()) => load_machine(identity).map(|reloaded| PairedMachine {
            origin_port: serving,
            ..reloaded
        }),
        Err(MachineApiError::Revoked) => Err(LegStop::Revoked {
            hostname: machine.hostname,
        }),
        Err(_) => Err(LegStop::OriginPortMismatch {
            paired: machine.origin_port,
            serving,
        }),
    }
}

/// The binary to run: the user's (version floor) or the managed one (pin and hashes).
pub(crate) fn acquire_binary(
    params: &LegParams,
    identity: &dyn CloudIdentity,
    stop: &AtomicBool,
    sink: &LegSink,
) -> Result<(PathBuf, BinarySource), LegStop> {
    let unavailable = LegStop::BinaryUnavailable;
    let path = params.settings.cloudflared_path.trim();
    if !path.is_empty() {
        let acquired = acquire::user_binary(path).map_err(unavailable)?;
        if let Some(warning) = acquired.warning {
            sink(CloudLegEvent::Warning(warning));
        }
        return Ok((acquired.path, BinarySource::User));
    }
    if version::pin_nearing_end_of_support(chrono::Utc::now().date_naive()) {
        sink(CloudLegEvent::Warning(format!(
            "yaran's cloudflared {} is nearing the end of Cloudflare's one-year support; update \
             yaran to get a newer one.",
            pins::PINNED_VERSION
        )));
    }
    let pin = super::cloudflared::current_target()
        .and_then(pin_for)
        .ok_or(unavailable(BinaryUnavailable::UnsupportedTarget))?;
    let mut last_report: Option<Instant> = None;
    let mut downloaded = false;
    let mut progress = |p: acquire::Progress| {
        downloaded = true;
        if last_report.is_none_or(|at| at.elapsed() >= Duration::from_secs(1)) {
            last_report = Some(Instant::now());
            sink(CloudLegEvent::Acquiring {
                pct: p
                    .total
                    .filter(|t| *t > 0)
                    .map(|t| u8::try_from(p.done * 100 / t).unwrap_or(100)),
                total_mb: p.total.map(|t| t / (1024 * 1024)),
            });
        }
        !stop.load(Ordering::SeqCst)
    };
    let result = acquire::managed_binary(
        &identity.cloud_dir(),
        pin,
        pins::PINNED_VERSION,
        &params.download,
        &mut progress,
    );
    match result {
        Ok(path) => {
            if downloaded {
                sink(CloudLegEvent::Acquired {
                    version: pins::PINNED_VERSION.to_string(),
                });
            }
            Ok((path, BinarySource::Managed))
        }
        Err(BinaryUnavailable::Cancelled) => Err(LegStop::Requested),
        Err(other) => Err(unavailable(other)),
    }
}
