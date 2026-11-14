//! Tests for the whole leg against a fake identity (09's seam) and a `/bin/sh` stand-in for
//! cloudflared, with an injected ready probe.
//!
//! - Test-only; spawns real child processes, never touches the network.
//!
//! <module-headers:begin>
//! Uses:
//! cloud/leg_tests.rs
//! ├── cloud::cloudflared::acquire
//! ├── cloud::cloudflared::ready
//! ├── cloud::cloudflared::test_support
//! ├── cloud::leg
//! ├── cloud::leg_seam
//! ├── cloud::protocol::machine
//! └── cloud::protocol::test_fixtures
//! External: serde_json, std, tempfile
//!
//! Used by:
//! cloud/leg_tests.rs
//! └── cloud::leg
//! <module-headers:end>

use super::*;
use crate::cloud::cloudflared::acquire::BinaryUnavailable;
use crate::cloud::cloudflared::ready::Readiness;
use crate::cloud::cloudflared::test_support::script;
use crate::cloud::leg_seam::{
    CloudLegSettings, CredentialsRevision, MachineApiError, PairedMachine, RotateReason,
};
use crate::cloud::protocol::machine::MachineConfig;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicU8;

#[derive(Default)]
struct Calls {
    set_origin: Vec<u16>,
    rotate: Vec<RotateReason>,
}

struct FakeIdentity {
    dir: PathBuf,
    machine: Mutex<Option<PairedMachine>>,
    config: Mutex<Result<i64, MachineApiError>>,
    set_origin: Mutex<Result<(), MachineApiError>>,
    calls: Mutex<Calls>,
}

impl FakeIdentity {
    fn paired(dir: PathBuf, origin_port: u16) -> Arc<Self> {
        Arc::new(Self {
            dir,
            machine: Mutex::new(Some(PairedMachine {
                hostname: "laptop.example.com".into(),
                team_domain: "team.cloudflareaccess.com".into(),
                aud: "aud".into(),
                owner_email: "me@example.com".into(),
                org_url: "https://org.example.com".into(),
                org_name: "Org".into(),
                origin_port,
                token_version: 1,
                tunnel_token: "tok-SECRET-1".into(),
                revoked: false,
            })),
            config: Mutex::new(Ok(1)),
            set_origin: Mutex::new(Ok(())),
            calls: Mutex::default(),
        })
    }
}

impl CloudIdentity for FakeIdentity {
    fn cloud_dir(&self) -> PathBuf {
        self.dir.clone()
    }
    fn revision(&self) -> Option<CredentialsRevision> {
        let m = self.machine.lock().unwrap();
        m.as_ref()
            .map(|m| CredentialsRevision(m.token_version as u64, 0, 0, 0))
    }
    fn load(&self) -> Result<Option<PairedMachine>, String> {
        Ok(self.machine.lock().unwrap().clone())
    }
    fn revoked(&self) -> bool {
        false
    }
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError> {
        let version = self.config.lock().unwrap().clone()?;
        let (valid, _) = crate::cloud::protocol::test_fixtures::api_cases("MachineConfig");
        let mut config: MachineConfig = serde_json::from_value(valid[0].1.clone()).unwrap();
        config.tunnel.token_version = version;
        config.origin_port = self
            .machine
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |m| i64::from(m.origin_port));
        Ok(config)
    }
    fn rotate(&self, reason: RotateReason) -> Result<(), MachineApiError> {
        self.calls.lock().unwrap().rotate.push(reason);
        if let Some(m) = self.machine.lock().unwrap().as_mut() {
            m.token_version += 1;
            m.tunnel_token = format!("tok-SECRET-{}", m.token_version);
        }
        Ok(())
    }
    fn set_origin(&self, port: u16) -> Result<(), MachineApiError> {
        self.calls.lock().unwrap().set_origin.push(port);
        let result = self.set_origin.lock().unwrap().clone();
        if result.is_ok()
            && let Some(m) = self.machine.lock().unwrap().as_mut()
        {
            m.origin_port = port;
        }
        result
    }
}

struct Harness {
    dir: tempfile::TempDir,
    _origin: std::net::TcpListener,
    port: u16,
    ready: Arc<AtomicU8>,
    events: Arc<Mutex<Vec<CloudLegEvent>>>,
}

const FAKE_CF: &str = r#"if [ "$1" = "--version" ]; then echo "cloudflared version 2026.11.0"; exit 0; fi
echo '{"level":"info","message":"Registered tunnel connection"}' >&2
while true; do sleep 0.1; done"#;

impl Harness {
    fn new() -> Self {
        let origin = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = origin.local_addr().unwrap().port();
        Self {
            dir: tempfile::tempdir().unwrap(),
            _origin: origin,
            port,
            ready: Arc::new(AtomicU8::new(1)),
            events: Arc::default(),
        }
    }

    fn params(&self, body: &str) -> LegParams {
        let bin = script(self.dir.path(), "cloudflared", body);
        let settings = CloudLegSettings {
            cloudflared_path: bin.to_str().unwrap().into(),
            grace_period_seconds: 0,
            restart_backoff_initial_ms: 50,
            restart_backoff_max_ms: 100,
            restart_backoff_jitter_ms: 0,
            unauthorized_confirm_seconds: 1,
            ..CloudLegSettings::default()
        };
        let ready = self.ready.clone();
        LegParams {
            probe: Arc::new(move |_| match ready.load(Ordering::SeqCst) {
                1 => Readiness::Ready { connections: 4 },
                _ => Readiness::NotReady,
            }),
            ..LegParams::new(settings, self.port)
        }
    }

    fn start(&self, params: LegParams, identity: Arc<FakeIdentity>) -> CloudLeg {
        let events = self.events.clone();
        CloudLeg::start(
            params,
            identity,
            Arc::new(move |e| events.lock().unwrap().push(e)),
            None,
        )
    }

    fn wait_for(&self, what: &str, pred: impl Fn(&CloudLegEvent) -> bool) {
        let until = Instant::now() + Duration::from_secs(15);
        while !self.events.lock().unwrap().iter().any(&pred) {
            assert!(
                Instant::now() < until,
                "never saw {what}: {:?}",
                self.events.lock().unwrap()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stopped(&self) -> Option<LegStop> {
        self.events.lock().unwrap().iter().find_map(|e| match e {
            CloudLegEvent::Stopped(stop) => Some(stop.clone()),
            _ => None,
        })
    }

    fn wait_stopped(&self) -> LegStop {
        self.wait_for("Stopped", |e| matches!(e, CloudLegEvent::Stopped(_)));
        self.stopped().unwrap()
    }
}

#[test]
fn a_paired_leg_reaches_ready_and_stops_without_leaving_anything() {
    let h = Harness::new();
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    let leg = h.start(h.params(FAKE_CF), id.clone());
    h.wait_for("Ready", |e| matches!(e, CloudLegEvent::Ready { .. }));
    let state = id.read_leg_state().expect("the leg records its child");
    assert_eq!(state.state, "ready");
    let token = std::fs::read_to_string(h.dir.path().join("tunnel-token")).unwrap();
    assert_eq!(token, "tok-SECRET-1");
    let cmdline = std::process::Command::new("ps")
        .args(["-o", "command=", "-p", &state.pid.to_string()])
        .output()
        .unwrap();
    assert!(!String::from_utf8_lossy(&cmdline.stdout).contains("SECRET"));
    assert!(
        !std::fs::read_to_string(id.leg_state_path())
            .unwrap()
            .contains("SECRET")
    );
    leg.request_stop();
    assert_eq!(h.wait_stopped(), LegStop::Requested);
    leg.join();
    assert!(!h.dir.path().join("tunnel-token").exists());
    assert!(id.read_leg_state().is_none());
    assert!(!crate::cloud::cloudflared::child_registry::live().contains(&(state.pid as i32)));
}

#[test]
fn a_different_serving_port_is_reported_before_the_spawn() {
    let h = Harness::new();
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), 3890);
    let leg = h.start(h.params(FAKE_CF), id.clone());
    h.wait_for("Ready", |e| matches!(e, CloudLegEvent::Ready { .. }));
    assert_eq!(id.calls.lock().unwrap().set_origin, vec![h.port]);
    drop(leg);
    h.wait_stopped();
}

#[test]
fn a_failed_origin_update_stops_as_a_mismatch_and_410_as_revoked() {
    for (answer, expect_revoked) in [
        (MachineApiError::Network("offline".into()), false),
        (MachineApiError::Revoked, true),
    ] {
        let h = Harness::new();
        let id = FakeIdentity::paired(h.dir.path().to_path_buf(), 3890);
        *id.set_origin.lock().unwrap() = Err(answer);
        let _leg = h.start(h.params(FAKE_CF), id.clone());
        match h.wait_stopped() {
            LegStop::Revoked { .. } => assert!(expect_revoked),
            LegStop::OriginPortMismatch { paired, serving } => {
                assert!(!expect_revoked);
                assert_eq!((paired, serving), (3890, h.port));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(!h.events.lock().unwrap().contains(&CloudLegEvent::Starting));
    }
}

#[test]
fn unpaired_and_unreachable_origins_never_spawn() {
    let h = Harness::new();
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    *id.machine.lock().unwrap() = None;
    let _leg = h.start(h.params(FAKE_CF), id);
    assert_eq!(h.wait_stopped(), LegStop::CredentialsGone);

    let h = Harness::new();
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    let mut params = h.params(FAKE_CF);
    let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    params.serving_port = free.local_addr().unwrap().port();
    drop(free);
    *id.machine.lock().unwrap() = id.load().unwrap().map(|m| PairedMachine {
        origin_port: params.serving_port,
        ..m
    });
    let _leg = h.start(params.clone(), id);
    assert_eq!(
        h.wait_stopped(),
        LegStop::NoLoopbackPrimary {
            port: params.serving_port
        }
    );
}

#[test]
fn a_user_binary_below_the_floor_is_refused_and_never_run() {
    let h = Harness::new();
    let marker = h.dir.path().join("ran");
    let body = format!(
        "if [ \"$1\" = \"--version\" ]; then echo 'cloudflared version 2026.10.0'; exit 0; fi\ntouch {}",
        marker.display()
    );
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    let _leg = h.start(h.params(&body), id);
    assert!(matches!(
        h.wait_stopped(),
        LegStop::BinaryUnavailable(BinaryUnavailable::TooOld { .. })
    ));
    assert!(!marker.exists());
}

#[test]
fn unauthorized_with_a_newer_token_version_syncs_and_restarts() {
    let h = Harness::new();
    h.ready.store(0, Ordering::SeqCst);
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    *id.config.lock().unwrap() = Ok(2);
    let body = FAKE_CF.replace(
        "Registered tunnel connection\"}' >&2",
        "Register tunnel error\",\"level\":\"error\",\"error\":\"Unauthorized: x\"}' >&2",
    );
    let leg = h.start(h.params(&body), id.clone());
    h.wait_for("Healing", |e| *e == CloudLegEvent::Healing);
    let until = Instant::now() + Duration::from_secs(10);
    while id.calls.lock().unwrap().rotate.is_empty() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(id.calls.lock().unwrap().rotate[0], RotateReason::Sync);
    h.ready.store(1, Ordering::SeqCst);
    h.wait_for("Ready after the heal", |e| {
        matches!(e, CloudLegEvent::Ready { .. })
    });
    assert_eq!(
        std::fs::read_to_string(h.dir.path().join("tunnel-token")).unwrap(),
        "tok-SECRET-2"
    );
    drop(leg);
    h.wait_stopped();
}

#[test]
fn unauthorized_with_an_equal_version_rotates_once_then_fails() {
    let h = Harness::new();
    h.ready.store(0, Ordering::SeqCst);
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    // The config always reports the version the fake currently holds.
    *id.config.lock().unwrap() = Ok(1);
    let body = FAKE_CF.replace(
        "Registered tunnel connection\"}' >&2",
        "x\",\"error\":\"Unauthorized: x\"}' >&2",
    );
    let _leg = h.start(h.params(&body), id.clone());
    let until = Instant::now() + Duration::from_secs(10);
    while id.calls.lock().unwrap().rotate.is_empty() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(20));
    }
    *id.config.lock().unwrap() = Ok(2);
    assert!(matches!(h.wait_stopped(), LegStop::HealFailed { .. }));
    assert_eq!(id.calls.lock().unwrap().rotate, vec![RotateReason::User]);
}

#[test]
fn a_revoked_config_answer_stops_and_clock_skew_keeps_the_child() {
    let h = Harness::new();
    h.ready.store(0, Ordering::SeqCst);
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    *id.config.lock().unwrap() = Err(MachineApiError::ClockSkew {
        server_time: "2020-01-01T00:00:00Z".into(),
    });
    let body = FAKE_CF.replace(
        "Registered tunnel connection\"}' >&2",
        "x\",\"error\":\"Unauthorized: x\"}' >&2",
    );
    let _leg = h.start(h.params(&body), id.clone());
    h.wait_for(
        "the clock warning",
        |e| matches!(e, CloudLegEvent::Warning(w) if w.contains("clock is off by")),
    );
    assert!(h.stopped().is_none(), "clock skew keeps the child");
    *id.config.lock().unwrap() = Err(MachineApiError::Revoked);
    assert!(matches!(h.wait_stopped(), LegStop::Revoked { .. }));
}

#[test]
fn exit_255_heals_and_a_crash_restarts_with_one_warning() {
    let h = Harness::new();
    let id = FakeIdentity::paired(h.dir.path().to_path_buf(), h.port);
    *id.config.lock().unwrap() = Ok(2);
    let marker = h.dir.path().join("count");
    let body = format!(
        "if [ \"$1\" = \"--version\" ]; then echo 'cloudflared version 2026.11.0'; exit 0; fi\n\
         echo x >> {m}\nif [ $(wc -l < {m}) -eq 1 ]; then exit 255; fi\nexit 1",
        m = marker.display()
    );
    let _leg = h.start(h.params(&body), id.clone());
    h.wait_for("a restart", |e| {
        matches!(e, CloudLegEvent::Restarting { first: true, .. })
    });
    assert_eq!(id.calls.lock().unwrap().rotate, vec![RotateReason::Sync]);
}
