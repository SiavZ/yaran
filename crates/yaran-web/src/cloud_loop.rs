//! The serve loop's cloud arm: owns the one `CloudLeg`, plans every input, and is the
//! only writer of the ingress cell and the shared view.
//!
//! Inputs arrive on the `CloudModeControl` lane: mode requests (answered at once; a mode
//! reply never waits out a download), `[cloud]` key changes, credentials snapshots from
//! the 2 s `CredentialsWatch`, and the leg's own events tagged with a generation so a
//! superseded leg can never write the ingress cell.
//!
//! - Runs inside the serve loop's `tokio::select!`; does no blocking I/O of its own (the
//!   leg and the credentials watch are std threads).
//! - Posts keyed statuses (`cloud-mode`, `cloud-leg`, `cloud-cloudflared`), console lines
//!   for `yaran server`, and fires `cloud.changed` on every view change.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_loop.rs
//! ├── cloud_ingress
//! ├── cloud_loop::live_cloud_mode_tests
//! ├── cloud_mode
//! ├── console
//! ├── engine_actor
//! ├── yaran-core::cloud::cloudflared::child_registry
//! ├── yaran-core::cloud::cloudflared::command
//! ├── yaran-core::cloud::leg
//! ├── yaran-core::cloud::leg_identity
//! ├── yaran-core::cloud::leg_outcome
//! ├── yaran-core::cloud::paths
//! ├── yaran-core::cloud::planner
//! ├── yaran-core::cloud::view
//! ├── yaran-core::config
//! ├── yaran-core::engine
//! └── yaran-core::statusline
//! External: chrono, std, tokio
//!
//! Used by:
//! cloud_loop.rs
//! ├── cloud_loop::live_cloud_mode_tests
//! └── crate
//! <module-headers:end>

use std::sync::Arc;

use yaran_core::cloud::cloudflared::child_registry;
use yaran_core::cloud::leg::{
    CloudLeg, CloudLegEvent, CredentialsWatch, LegParams, LegStop, ReadyProbe,
};
use yaran_core::cloud::leg_identity::{CloudIdentity, CloudLegSettings, PairedMachine};
use yaran_core::cloud::leg_outcome::{CloudModeOutcome, leg_status, tls_disclosure};
use yaran_core::cloud::planner::{
    CloudStep, Desired, Pairing, StopReason, desired_leg, plan_cloud_change,
};
use yaran_core::cloud::view::{CloudLegState, CloudLegView};

use yaran_core::engine::StatusUpdate;
use yaran_core::statusline::StatusTone;

use crate::cloud_ingress::{CloudBindingInput, CloudIngress, JwksOutcome};
use crate::cloud_mode::{CloudInput, CloudModeControl, CredentialsSnapshot};

/// The keyed status for the tunnel's Access check (a refused binding, unreachable keys).
const CLOUD_ACCESS_KEY: &str = "cloud-access";
use crate::console::Console;

pub(crate) struct CloudLoop {
    rx: tokio::sync::mpsc::Receiver<CloudInput>,
    control: CloudModeControl,
    identity: Arc<dyn CloudIdentity>,
    settings: CloudLegSettings,
    serving_port: u16,
    status: Option<crate::engine_actor::EngineHandle>,
    console: Console,
    credentials: CredentialsSnapshot,
    seen_credentials: bool,
    leg: Option<CloudLeg>,
    stopping: Option<CloudLeg>,
    generation: u64,
    running_token_version: Option<i64>,
    told_tls: bool,
    watch: Option<CredentialsWatch>,
    probe: Option<ReadyProbe>,
}

impl CloudLoop {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        rx: tokio::sync::mpsc::Receiver<CloudInput>,
        control: CloudModeControl,
        identity: Arc<dyn CloudIdentity>,
        settings: CloudLegSettings,
        serving_port: u16,
        status: Option<crate::engine_actor::EngineHandle>,
        console: Console,
    ) -> Self {
        Self {
            rx,
            control,
            identity,
            settings,
            serving_port,
            status,
            console,
            credentials: CredentialsSnapshot::Unpaired,
            seen_credentials: false,
            leg: None,
            stopping: None,
            generation: 0,
            running_token_version: None,
            told_tls: false,
            watch: None,
            probe: None,
        }
    }

    /// Replace the `/ready` probe (tests drive readiness without HTTP).
    #[cfg(test)]
    pub(crate) fn with_probe(mut self, probe: ReadyProbe) -> Self {
        self.probe = Some(probe);
        self
    }

    /// Start watching the credentials; the first snapshot arrives at once.
    pub(crate) fn start(&mut self) {
        let identity = self.identity.clone();
        let tx = self.control.sender();
        let on_change = Box::new(move || {
            let snapshot = match identity.load() {
                Ok(Some(machine)) => CredentialsSnapshot::Paired(Box::new(PairedMachine {
                    revoked: machine.revoked || identity.revoked(),
                    ..machine
                })),
                Ok(None) | Err(_) => CredentialsSnapshot::Unpaired,
            };
            let _ = tx.blocking_send(CloudInput::Credentials(snapshot));
        });
        self.watch = Some(CredentialsWatch::spawn(
            self.identity.clone(),
            yaran_core::cloud::leg::CREDENTIALS_POLL,
            on_change,
        ));
    }

    /// The next input. Never `None`: the loop holds the control, and with it a sender.
    pub(crate) async fn recv(&mut self) -> Option<CloudInput> {
        self.rx.recv().await
    }

    pub(crate) fn apply(&mut self, input: CloudInput) {
        match input {
            CloudInput::Mode { mode, reply } => {
                self.settings.mode = mode;
                let outcome = self.reconcile(false);
                let _ = reply.send(outcome);
            }
            CloudInput::Settings(next) => {
                let restart = self.settings.restart_keys_differ(&next);
                self.settings = CloudLegSettings {
                    mode: self.settings.mode,
                    ..next
                };
                if restart {
                    self.reconcile(true);
                }
            }
            CloudInput::Credentials(snapshot) => self.credentials_changed(snapshot),
            CloudInput::Leg { generation, event } if generation == self.generation => {
                self.leg_event(event);
            }
            CloudInput::Leg { .. } => {}
        }
    }

    fn machine(&self) -> Option<&PairedMachine> {
        match &self.credentials {
            CredentialsSnapshot::Paired(machine) => Some(machine),
            CredentialsSnapshot::Unpaired => None,
        }
    }

    fn credentials_changed(&mut self, snapshot: CredentialsSnapshot) {
        let first = !std::mem::replace(&mut self.seen_credentials, true);
        // A re-pair or a token another process rotated restarts the child; the leg's own
        // W32 origin rewrite and its own heal (already restarted) do not.
        let identity_of = |s: &CredentialsSnapshot| match s {
            CredentialsSnapshot::Paired(m) => Some((
                m.hostname.clone(),
                m.org_url.clone(),
                m.team_domain.clone(),
                m.aud.clone(),
                m.owner_email.clone(),
                m.revoked,
            )),
            CredentialsSnapshot::Unpaired => None,
        };
        let repaired = identity_of(&snapshot) != identity_of(&self.credentials);
        self.credentials = snapshot;
        let new_token = self.machine().is_some_and(|m| {
            self.running_token_version
                .is_some_and(|v| v != m.token_version)
        });
        if !first && !repaired && !new_token {
            return;
        }
        let outcome = self.reconcile(!first && self.leg.is_some());
        if first
            && outcome == CloudModeOutcome::NotPaired
            && self.settings.mode.warns_when_unpaired()
        {
            self.post(outcome.status(self.settings.mode));
        }
    }

    fn reconcile(&mut self, restart: bool) -> CloudModeOutcome {
        let pairing = match self.machine() {
            None => Pairing::Unpaired,
            Some(m) if m.revoked => Pairing::Revoked,
            Some(_) => Pairing::Paired,
        };
        let desired = desired_leg(self.settings.mode, pairing);
        let steps = plan_cloud_change(self.leg.is_some(), desired, restart);
        for step in &steps {
            match step {
                CloudStep::StopLeg => self.stop_leg(),
                CloudStep::StartLeg => self.start_leg(),
            }
        }
        let hostname = self
            .machine()
            .map(|m| m.hostname.clone())
            .unwrap_or_default();
        match desired {
            Desired::Run if steps.contains(&CloudStep::StartLeg) => {
                self.set_state(CloudLegState::Starting, None);
                CloudModeOutcome::Starting { hostname }
            }
            Desired::Run => CloudModeOutcome::AlreadyRunning { hostname },
            Desired::Stop(StopReason::ModeOff) => {
                self.set_state(CloudLegState::Off, None);
                CloudModeOutcome::Stopped
            }
            Desired::Stop(StopReason::NotPaired) => {
                self.set_state(CloudLegState::Unpaired, None);
                CloudModeOutcome::NotPaired
            }
            Desired::Stop(StopReason::Revoked) => {
                self.set_state(CloudLegState::Revoked, None);
                CloudModeOutcome::Revoked { hostname }
            }
        }
    }

    fn stop_leg(&mut self) {
        self.generation += 1;
        self.ingress().unbind();
        self.running_token_version = None;
        if let Some(leg) = self.leg.take() {
            leg.request_stop();
            self.stopping = Some(leg);
        }
    }

    fn start_leg(&mut self) {
        self.generation += 1;
        let generation = self.generation;
        let tx = self.control.sender();
        let sink = Arc::new(move |event| {
            let _ = tx.blocking_send(CloudInput::Leg { generation, event });
        });
        let mut params = LegParams::new(self.settings.clone(), self.serving_port);
        if let Some(probe) = &self.probe {
            params.probe = probe.clone();
        }
        self.leg = Some(CloudLeg::start(
            params,
            self.identity.clone(),
            sink,
            self.stopping.take(),
        ));
    }

    fn leg_event(&mut self, event: CloudLegEvent) {
        let (hostname, owner) = self
            .machine()
            .map(|m| (m.hostname.clone(), m.owner_email.clone()))
            .unwrap_or_default();
        match &event {
            CloudLegEvent::Acquiring { pct, .. } => {
                self.set_state(CloudLegState::Acquiring { pct: *pct }, None)
            }
            CloudLegEvent::Acquired { .. } | CloudLegEvent::Warning(_) => {}
            CloudLegEvent::Starting { token_version } => {
                self.running_token_version = Some(*token_version);
                self.ingress().unbind();
                self.set_state(CloudLegState::Starting, None);
            }
            CloudLegEvent::Ready { .. } => {
                self.bind_ingress();
                self.set_state(CloudLegState::Ready, None);
                self.console.leg_changed(&format!(
                    "[cloud] remote access is live at https://{hostname}"
                ));
                if !std::mem::replace(&mut self.told_tls, true) {
                    self.console
                        .leg_changed(&format!("[cloud] {}", tls_disclosure(&hostname)));
                }
            }
            CloudLegEvent::NotReady | CloudLegEvent::Restarting { .. } => {
                let was_ready = self.control.view().state == CloudLegState::Ready;
                self.ingress().unbind();
                self.set_state(CloudLegState::Reconnecting, None);
                if was_ready {
                    self.console.bind_degraded(&format!(
                        "[cloud] remote access to {hostname} was lost; cloudflared is reconnecting"
                    ));
                }
            }
            CloudLegEvent::Healing => {
                self.ingress().unbind();
                self.set_state(CloudLegState::Healing, None);
            }
            CloudLegEvent::Stopped(stop) => {
                self.ingress().unbind();
                self.leg = None;
                self.running_token_version = None;
                self.leg_stopped(stop);
            }
        }
        if let Some(update) = leg_status(&event, &hostname, &owner, self.settings.mode) {
            self.post(update);
        }
    }

    fn leg_stopped(&mut self, stop: &LegStop) {
        let sentence = leg_status(
            &CloudLegEvent::Stopped(stop.clone()),
            "",
            "",
            self.settings.mode,
        )
        .map(|update| update.message);
        match stop {
            LegStop::Requested => {}
            LegStop::CredentialsGone => self.set_state(CloudLegState::Unpaired, None),
            LegStop::Revoked { .. } => {
                self.set_state(CloudLegState::Revoked, sentence.clone());
                if let Some(text) = sentence {
                    self.console.bind_degraded(&format!("[cloud] {text}"));
                }
            }
            LegStop::BinaryUnavailable(_)
            | LegStop::NoLoopbackPrimary { .. }
            | LegStop::OriginPortMismatch { .. }
            | LegStop::HealFailed { .. } => {
                self.set_state(CloudLegState::Failed, sentence.clone());
                if let Some(text) = sentence {
                    self.console.bind_degraded(&format!("[cloud] {text}"));
                }
            }
        }
    }

    fn ingress(&self) -> &CloudIngress {
        self.control.ingress()
    }

    /// cloudflared is ready: put the Access check in front of the tunnel hostname. A
    /// refused binding keeps the hostname closed and says why on both surfaces.
    fn bind_ingress(&self) {
        let Some(m) = self.machine() else {
            return;
        };
        let input = CloudBindingInput {
            hostname: m.hostname.clone(),
            team_domain: m.team_domain.clone(),
            aud: m.aud.clone(),
            owner_email: m.owner_email.clone(),
        };
        let status = self.status.clone();
        let team = m.team_domain.clone();
        let report = Box::new(move |outcome| {
            if let (JwksOutcome::Unavailable(why), Some(handle)) = (outcome, status) {
                handle.post_status(jwks_unavailable(&team, &why));
            }
        });
        if let Err(refusal) = self.ingress().bind(input, report) {
            let sentence = format!("Remote access stays closed: {}.", refusal.sentence());
            self.console.bind_degraded(&format!("[cloud] {sentence}"));
            self.post(
                StatusUpdate::keyed(CLOUD_ACCESS_KEY, StatusTone::Warning, sentence).sticky(),
            );
        }
    }

    fn set_state(&self, state: CloudLegState, detail: Option<String>) {
        let current = self.control.view();
        if current.state == state && current.mode == self.settings.mode && current.detail == detail
        {
            return;
        }
        let machine = self.machine();
        let view = CloudLegView {
            mode: self.settings.mode,
            state,
            hostname: machine.map(|m| m.hostname.clone()),
            org_url: machine.map(|m| m.org_url.clone()),
            org_name: machine.map(|m| m.org_name.clone()),
            since: Some(chrono::Utc::now().to_rfc3339()),
            detail,
        };
        if self.control.shared_view().replace(view) {
            self.control.notify_changed();
        }
    }

    fn post(&self, update: StatusUpdate) {
        if let Some(handle) = &self.status {
            handle.post_status(update);
        }
    }

    /// The serve is ending: stop the leg (non-blocking), SIGTERM every recorded group,
    /// and take the ingress rule down. The serve mode's wind-down then calls
    /// `child_registry::wait_all`.
    pub(crate) fn shutdown(&mut self) {
        self.watch = None;
        self.ingress().unbind();
        self.generation += 1;
        for leg in [self.leg.take(), self.stopping.take()]
            .into_iter()
            .flatten()
        {
            leg.request_stop();
        }
        child_registry::shutdown();
        self.set_state(CloudLegState::NotServing, None);
    }
}

/// The pre-warm could not fetch the Access keys: sign-ins fail until a later fetch works.
fn jwks_unavailable(team: &str, why: &str) -> StatusUpdate {
    StatusUpdate::keyed(
        CLOUD_ACCESS_KEY,
        StatusTone::Warning,
        format!(
            "yaran could not fetch the Cloudflare Access signing keys for {team} ({}), so phone \
             sign-ins are refused until it can; it tries again on the next sign-in.",
            yaran_core::sanitize::truncate(why, 200)
        ),
    )
}

/// Build this serve's cloud lane, its ingress and loop, and start watching the credentials.
/// `serving_port` is the loopback listener's port (the tunnel's origin).
pub(crate) fn build(
    runtime: tokio::runtime::Handle,
    config_root: &std::path::Path,
    config: &yaran_core::config::Config,
    serving_port: Option<u16>,
    status: Option<crate::engine_actor::EngineHandle>,
    console: Console,
) -> (CloudModeControl, CloudLoop) {
    // The tunnel's Access check: unbound until the leg reports ready, its settings live.
    let ingress = CloudIngress::new(Arc::new(yaran_core::cloud::paths::CloudPaths::from_root(
        config_root,
    )));
    ingress.update_settings(crate::cloud_ingress::IngressSettings::from(&config.cloud));
    let (control, rx) = CloudModeControl::new(runtime, ingress);
    let settings = yaran_core::cloud::leg_identity::settings_from_config(config);
    let mut cloud = CloudLoop::new(
        rx,
        control.clone(),
        yaran_core::cloud::leg_identity::production_identity(config_root, &settings),
        settings,
        serving_port.unwrap_or(0),
        status,
        console,
    );
    cloud.start();
    (control, cloud)
}

/// After a serve mode's wind-down: wait for every cloudflared to be reaped, then SIGKILL
/// whatever is left (grace plus the stop's own margin).
pub(crate) fn wait_for_children(config: &yaran_core::config::Config) {
    let grace = yaran_core::cloud::leg_identity::settings_from_config(config)
        .grace_period_seconds
        .min(yaran_core::cloud::cloudflared::command::MAX_GRACE_SECONDS);
    child_registry::wait_all(std::time::Duration::from_secs(grace + 3));
}

#[cfg(test)]
#[path = "cloud_loop_tests.rs"]
mod live_cloud_mode_tests;
