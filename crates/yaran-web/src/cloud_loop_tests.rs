//! `live_cloud_mode_tests`: the cloud arm end to end with a fake identity (Phase 09's
//! seam) and a `/bin/sh` stand-in for cloudflared, mirroring `live_tailscale_mode_tests`.
//!
//! - Test-only; spawns real child processes, no network.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_loop_tests.rs
//! ├── cloud_loop
//! ├── cloud_mode
//! └── console
//! External: tempfile, tokio, yaran_core
//!
//! Used by:
//! cloud_loop_tests.rs
//! └── cloud_loop
//! <module-headers:end>

use super::*;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;
use yaran_core::cloud::cloudflared::ready::Readiness;
use yaran_core::cloud::ingress_cell::LiveCloudIngress;
use yaran_core::cloud::leg_seam::{CloudMode, CredentialsRevision, MachineApiError, RotateReason};
use yaran_core::cloud::protocol::machine::MachineConfig;

struct Fake {
    dir: std::path::PathBuf,
    machine: Mutex<Option<PairedMachine>>,
    rev: std::sync::atomic::AtomicU64,
}

impl CloudIdentity for Fake {
    fn cloud_dir(&self) -> std::path::PathBuf {
        self.dir.clone()
    }
    fn revision(&self) -> Option<CredentialsRevision> {
        Some(CredentialsRevision(
            self.rev.load(Ordering::SeqCst),
            0,
            0,
            0,
        ))
    }
    fn load(&self) -> Result<Option<PairedMachine>, String> {
        Ok(self.machine.lock().unwrap().clone())
    }
    fn revoked(&self) -> bool {
        false
    }
    fn machine_config(&self) -> Result<MachineConfig, MachineApiError> {
        Err(MachineApiError::Network("offline".into()))
    }
    fn rotate(&self, _: RotateReason) -> Result<(), MachineApiError> {
        Err(MachineApiError::Network("offline".into()))
    }
    fn set_origin(&self, _: u16) -> Result<(), MachineApiError> {
        Err(MachineApiError::Network("offline".into()))
    }
}

fn machine(port: u16) -> PairedMachine {
    PairedMachine {
        hostname: "laptop.example.com".into(),
        team_domain: "team.cloudflareaccess.com".into(),
        aud: "aud".into(),
        owner_email: "me@example.com".into(),
        org_url: "https://org.example.com".into(),
        org_name: "Org".into(),
        origin_port: port,
        token_version: 1,
        tunnel_token: "tok-1".into(),
        revoked: false,
    }
}

struct Rig {
    _dir: tempfile::TempDir,
    _origin: std::net::TcpListener,
    fake: Arc<Fake>,
    control: CloudModeControl,
    ready: Arc<AtomicU8>,
}

/// A loop with a paired (or not) fake, already started, driven on its own task.
async fn rig(
    paired: bool,
    mode: CloudMode,
) -> (
    Rig,
    tokio::task::JoinHandle<CloudLoop>,
    tokio::sync::oneshot::Sender<()>,
) {
    let dir = tempfile::tempdir().unwrap();
    let origin = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = origin.local_addr().unwrap().port();
    let bin = dir.path().join("cloudflared");
    std::fs::write(
        &bin,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'cloudflared version 2026.11.0'; exit 0; fi\nwhile true; do sleep 0.1; done\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    let fake = Arc::new(Fake {
        dir: dir.path().to_path_buf(),
        machine: Mutex::new(paired.then(|| machine(port))),
        rev: Default::default(),
    });
    let (writer, reader) = LiveCloudIngress::new();
    let (control, rx) = CloudModeControl::new(tokio::runtime::Handle::current(), reader);
    let settings = CloudLegSettings {
        mode,
        cloudflared_path: bin.to_str().unwrap().into(),
        grace_period_seconds: 0,
        ..CloudLegSettings::default()
    };
    let ready = Arc::new(AtomicU8::new(1));
    let probe_ready = ready.clone();
    let mut cloud = CloudLoop::new(
        rx,
        control.clone(),
        writer,
        fake.clone(),
        settings,
        port,
        None,
        Console::noop(),
    )
    .with_probe(Arc::new(move |_| {
        match probe_ready.load(Ordering::SeqCst) {
            1 => Readiness::Ready { connections: 1 },
            _ => Readiness::NotReady,
        }
    }));
    cloud.start();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                Some(input) = cloud.recv() => cloud.apply(input),
            }
        }
        cloud.shutdown();
        cloud
    });
    (
        Rig {
            _dir: dir,
            _origin: origin,
            fake,
            control,
            ready,
        },
        task,
        stop_tx,
    )
}

async fn wait_state(control: &CloudModeControl, want: CloudLegState) {
    let until = tokio::time::Instant::now() + Duration::from_secs(15);
    while control.view().state != want {
        assert!(
            tokio::time::Instant::now() < until,
            "never reached {want:?}: {:?}",
            control.view()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paired_machine_reaches_ready_and_shutdown_leaves_no_child() {
    let (rig, task, stop) = rig(true, CloudMode::Auto).await;
    wait_state(&rig.control, CloudLegState::Ready).await;
    let ingress = rig.control.ingress().current().expect("set on Ready");
    assert_eq!(ingress.hostname, "laptop.example.com");
    let pid = rig.fake.read_leg_state().expect("recorded").pid;
    rig.ready.store(0, Ordering::SeqCst);
    wait_state(&rig.control, CloudLegState::Reconnecting).await;
    assert!(
        rig.control.ingress().current().is_none(),
        "cleared when not Ready"
    );
    stop.send(()).unwrap();
    task.await.unwrap();
    assert!(rig.control.ingress().current().is_none());
    assert_eq!(rig.control.view().state, CloudLegState::NotServing);
    // `child_registry::wait_all` is process-global, so tests running beside this one
    // would be swept too; wait on this child alone.
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !child_registry::live().is_empty() && child_registry::live().contains(&(pid as i32)) {
        assert!(
            std::time::Instant::now() < until,
            "the child outlived shutdown"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let alive = std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .unwrap();
    assert!(!alive.success(), "the child must be gone");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_mode_request_is_answered() {
    let (rig, task, stop) = rig(true, CloudMode::Auto).await;
    wait_state(&rig.control, CloudLegState::Ready).await;
    assert_eq!(
        rig.control.set_mode(CloudMode::Yes).await,
        CloudModeOutcome::AlreadyRunning {
            hostname: "laptop.example.com".into()
        }
    );
    assert_eq!(
        rig.control.set_mode(CloudMode::No).await,
        CloudModeOutcome::Stopped
    );
    wait_state(&rig.control, CloudLegState::Off).await;
    assert!(rig.control.ingress().current().is_none());
    assert_eq!(
        rig.control.set_mode(CloudMode::Auto).await,
        CloudModeOutcome::Starting {
            hostname: "laptop.example.com".into()
        }
    );
    wait_state(&rig.control, CloudLegState::Ready).await;
    stop.send(()).unwrap();
    task.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_closed_lane_answers_not_serving() {
    let (rig, task, stop) = rig(false, CloudMode::Auto).await;
    stop.send(()).unwrap();
    drop(task.await.unwrap());
    assert_eq!(
        rig.control.set_mode(CloudMode::Yes).await,
        CloudModeOutcome::NotServing
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_login_and_logout_start_and_stop_the_leg() {
    let (rig, task, stop) = rig(false, CloudMode::Auto).await;
    wait_state(&rig.control, CloudLegState::Unpaired).await;
    assert_eq!(
        rig.control.set_mode(CloudMode::Yes).await,
        CloudModeOutcome::NotPaired
    );
    let port = rig._origin.local_addr().unwrap().port();
    *rig.fake.machine.lock().unwrap() = Some(machine(port));
    rig.fake.rev.fetch_add(1, Ordering::SeqCst);
    wait_state(&rig.control, CloudLegState::Ready).await;
    *rig.fake.machine.lock().unwrap() = None;
    rig.fake.rev.fetch_add(1, Ordering::SeqCst);
    wait_state(&rig.control, CloudLegState::Unpaired).await;
    assert!(rig.control.ingress().current().is_none());
    stop.send(()).unwrap();
    task.await.unwrap();
}
