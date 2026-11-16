//! The live `[cloud] mode` lane: the one handle every surface changes the cloud leg
//! through while yaran serves (the `yaran server` and flip route, the engine actor's
//! reload arm, the terminal UI's companion in background mode).
//!
//! A request lane rather than a shared value, because a mode change is an act (start or
//! stop a supervised child) and only the serve loop may perform it. Every request is
//! answered; a lane whose loop has gone answers `NotServing`, a loop that does not answer
//! in time `TimedOut`. The same lane carries the leg's events, credentials changes and
//! `[cloud]` key changes into the loop, so the loop has one input arm.
//!
//! - Also hands out the shared view snapshot and the ingress reader (for Phase 11).
//!
//! <module-headers:begin>
//! Uses:
//! cloud_mode.rs
//! ├── cloud_ingress
//! ├── cloud_test_support
//! ├── yaran-core::cloud::config
//! ├── yaran-core::cloud::leg
//! ├── yaran-core::cloud::leg_identity
//! ├── yaran-core::cloud::leg_outcome
//! ├── yaran-core::cloud::view
//! └── yaran-core::engine
//! External: std, tokio
//!
//! Used by:
//! cloud_mode.rs
//! ├── background
//! ├── cloud_loop
//! ├── cloud_mode_routes
//! ├── crate
//! ├── engine_actor
//! ├── server
//! └── yaran[bin yaran]::companion
//! <module-headers:end>

use std::time::Duration;

use yaran_core::cloud::config::CloudConfig;
use yaran_core::cloud::leg::CloudLegEvent;
use yaran_core::cloud::leg_identity::{CloudLegSettings, CloudMode, PairedMachine};
use yaran_core::cloud::leg_outcome::CloudModeOutcome;
use yaran_core::cloud::view::{CloudLegView, SharedCloudView};

use crate::cloud_ingress::{CloudIngress, IngressSettings};

/// Depth of the lane. Mode changes are human-paced; the leg reports a few events a
/// second at most while downloading.
const INPUT_QUEUE: usize = 64;

/// How long a caller waits for the serve loop to answer (the Tailscale lane's bound:
/// no surface may hold a status op or an HTTP request open longer).
pub(crate) const MODE_REQUEST_TIMEOUT: Duration = Duration::from_secs(7);

/// What the credentials said at one poll.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CredentialsSnapshot {
    Unpaired,
    Paired(Box<PairedMachine>),
}

/// Everything the serve loop's cloud arm acts on.
pub(crate) enum CloudInput {
    Mode {
        mode: CloudMode,
        reply: tokio::sync::oneshot::Sender<CloudModeOutcome>,
    },
    /// A `[cloud]` key changed on reload.
    Settings(CloudLegSettings),
    Credentials(CredentialsSnapshot),
    Leg {
        generation: u64,
        event: CloudLegEvent,
    },
}

/// The handle. Cheap to clone.
#[derive(Clone)]
pub struct CloudModeControl {
    tx: tokio::sync::mpsc::Sender<CloudInput>,
    runtime: tokio::runtime::Handle,
    view: SharedCloudView,
    ingress: CloudIngress,
    changed: tokio::sync::broadcast::Sender<()>,
}

impl CloudModeControl {
    /// Build the control and the receiving end the serve loop owns.
    pub(crate) fn new(
        runtime: tokio::runtime::Handle,
        ingress: CloudIngress,
    ) -> (Self, tokio::sync::mpsc::Receiver<CloudInput>) {
        let (tx, rx) = tokio::sync::mpsc::channel(INPUT_QUEUE);
        let (changed, _) = tokio::sync::broadcast::channel(8);
        (
            Self {
                tx,
                runtime,
                view: SharedCloudView::default(),
                ingress,
                changed,
            },
            rx,
        )
    }

    pub(crate) fn sender(&self) -> tokio::sync::mpsc::Sender<CloudInput> {
        self.tx.clone()
    }

    /// The snapshot every surface reads.
    pub fn view(&self) -> CloudLegView {
        self.view.snapshot()
    }

    pub(crate) fn shared_view(&self) -> SharedCloudView {
        self.view.clone()
    }

    /// The tunnel ingress this loop binds and unbinds (the Host guard and the Access
    /// check read it).
    pub fn ingress(&self) -> &CloudIngress {
        &self.ingress
    }

    /// Fires `()` on every view change (the `cloud.changed` event).
    pub fn subscribe_changes(&self) -> tokio::sync::broadcast::Receiver<()> {
        self.changed.subscribe()
    }

    pub(crate) fn notify_changed(&self) {
        let _ = self.changed.send(());
    }

    /// Ask for a mode change from a thread with no runtime and report the answer.
    pub fn set_mode_detached(
        &self,
        mode: CloudMode,
        report: impl FnOnce(CloudModeOutcome) + Send + 'static,
    ) {
        let control = self.clone();
        self.runtime.spawn(async move {
            report(control.set_mode(mode).await);
        });
    }

    /// Ask the serve loop to change the mode and wait for what it did.
    pub async fn set_mode(&self, mode: CloudMode) -> CloudModeOutcome {
        let (reply, answer) = tokio::sync::oneshot::channel();
        if self
            .tx
            .send(CloudInput::Mode { mode, reply })
            .await
            .is_err()
        {
            return CloudModeOutcome::NotServing;
        }
        match tokio::time::timeout(MODE_REQUEST_TIMEOUT, answer).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => CloudModeOutcome::NotServing,
            Err(_) => CloudModeOutcome::TimedOut,
        }
    }

    /// Tell the loop the `[cloud]` keys changed (from a reload owner); a running child
    /// restarts when a key other than `mode` moved.
    pub fn settings_changed(&self, settings: CloudLegSettings) {
        let _ = self.tx.try_send(CloudInput::Settings(settings));
    }
}

/// The engine actor's slot for this serve's control, filled once the serve loop exists
/// (the actor is already running by then on `yaran server`). Empty means nothing serves.
pub(crate) type CloudControlSlot = std::sync::Arc<std::sync::OnceLock<CloudModeControl>>;

/// The reload owner's half (engine actor for `yaran server` and the flip; the terminal
/// UI's companion for background mode): a changed mode goes through the lane and
/// answers on `cloud-mode`; a changed restart key restarts a running child.
pub fn apply_reload(
    control: Option<&CloudModeControl>,
    previous: &CloudConfig,
    next: &CloudConfig,
    post: impl FnOnce(yaran_core::engine::StatusUpdate) + Send + 'static,
) {
    let Some(control) = control else {
        return;
    };
    apply_settings(control, previous, next);
    let mode = next.mode();
    if previous.mode() != mode {
        control.set_mode_detached(mode, move |outcome| post(outcome.status(mode)));
    }
}

/// The non-mode half of a reload: the ingress keys apply at once, and a changed restart
/// key restarts a running child.
pub fn apply_settings(control: &CloudModeControl, previous: &CloudConfig, next: &CloudConfig) {
    let ingress = IngressSettings::from(next);
    if IngressSettings::from(previous) != ingress {
        control.ingress().update_settings(ingress);
    }
    let leg = CloudLegSettings::from(next);
    if CloudLegSettings::from(previous).restart_keys_differ(&leg) {
        control.settings_changed(leg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_reload_asks_only_for_what_changed() {
        let ingress = crate::cloud_test_support::offline_ingress();
        let (control, mut rx) = CloudModeControl::new(tokio::runtime::Handle::current(), ingress);
        let base = CloudConfig::default();
        apply_reload(Some(&control), &base, &base.clone(), |_| {
            panic!("nothing changed")
        });
        assert!(rx.try_recv().is_err());
        let skew = CloudConfig {
            access_clock_skew_seconds: 99,
            ..base.clone()
        };
        apply_reload(Some(&control), &base, &skew, |_| panic!("no mode change"));
        assert!(rx.try_recv().is_err(), "an ingress key restarts nothing");
        assert_eq!(control.ingress().settings().clock_skew.as_secs(), 99);
        let port = CloudConfig {
            metrics_port: 20241,
            ..base.clone()
        };
        apply_reload(Some(&control), &base, &port, |_| panic!("no mode change"));
        assert!(
            matches!(rx.recv().await, Some(CloudInput::Settings(s)) if s.metrics_port == 20241)
        );
        let off = CloudConfig {
            mode: "no".into(),
            ..base.clone()
        };
        let (said_tx, said_rx) = tokio::sync::oneshot::channel();
        apply_reload(Some(&control), &base, &off, move |update| {
            let _ = said_tx.send(update);
        });
        match rx.recv().await {
            Some(CloudInput::Mode { mode, reply }) => {
                assert_eq!(mode, CloudMode::No);
                reply.send(CloudModeOutcome::Stopped).unwrap();
            }
            _ => panic!("expected a mode request"),
        }
        let update = said_rx.await.unwrap();
        assert_eq!(update.key.as_deref(), Some("cloud-mode"));
    }

    #[tokio::test]
    async fn a_dropped_loop_answers_not_serving() {
        let ingress = crate::cloud_test_support::offline_ingress();
        let (control, rx) = CloudModeControl::new(tokio::runtime::Handle::current(), ingress);
        drop(rx);
        assert_eq!(
            control.set_mode(CloudMode::Yes).await,
            CloudModeOutcome::NotServing
        );
    }
}
