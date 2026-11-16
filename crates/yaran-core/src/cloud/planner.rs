//! The cloud leg's pure planner: what should be running, and the steps that get there.
//!
//! The serve loop runs it on every input (a mode request, a credentials change, a
//! revocation, a config change, a terminal leg failure). Preconditions that need I/O (the
//! loopback origin answering, the paired origin port, a usable binary) are checked on the
//! leg's own thread when it starts and come back as terminal leg stops.
//!
//! - Pure.
//!
//! <module-headers:begin>
//! ```text
//! Uses:
//! cloud/planner.rs
//! └── cloud::leg_identity
//! External: none
//!
//! Used by:
//! cloud/planner.rs
//! ├── cloud
//! └── yaran-web::cloud_loop
//! ```
//! <module-headers:end>

use super::leg_identity::CloudMode;

/// What the credentials say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pairing {
    /// There is no pairing.
    Unpaired,
    /// The control plane says the pairing is revoked.
    Revoked,
    /// The machine is paired.
    Paired,
}

/// Why the leg should not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// `[cloud] mode` is off.
    ModeOff,
    /// The machine is not paired.
    NotPaired,
    /// The pairing is revoked.
    Revoked,
}

/// Whether the leg should run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired {
    /// It should.
    Run,
    /// It should not, and why.
    Stop(StopReason),
}

/// The desired state for a serving process.
pub fn desired_leg(mode: CloudMode, pairing: Pairing) -> Desired {
    if !mode.wants_leg() {
        return Desired::Stop(StopReason::ModeOff);
    }
    match pairing {
        Pairing::Unpaired => Desired::Stop(StopReason::NotPaired),
        Pairing::Revoked => Desired::Stop(StopReason::Revoked),
        Pairing::Paired => Desired::Run,
    }
}

/// One step the serve loop takes on the leg.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudStep {
    /// Stop the running leg.
    StopLeg,
    /// Start a leg.
    StartLeg,
}

/// Whether a leg runs now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LegNow {
    /// One runs.
    Running,
    /// None does.
    Stopped,
}

/// Whether a running leg is kept or replaced by a fresh child.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refresh {
    /// Keep it.
    Keep,
    /// Replace it: new credentials or changed `[cloud]` keys.
    Restart,
}

/// The steps from `now` to `desired`.
pub fn plan_cloud_change(now: LegNow, desired: Desired, refresh: Refresh) -> Vec<CloudStep> {
    match (now, desired) {
        (LegNow::Running, Desired::Run) if refresh == Refresh::Restart => {
            vec![CloudStep::StopLeg, CloudStep::StartLeg]
        }
        (LegNow::Running, Desired::Stop(_)) => vec![CloudStep::StopLeg],
        (LegNow::Stopped, Desired::Run) => vec![CloudStep::StartLeg],
        (LegNow::Running, Desired::Run) | (LegNow::Stopped, Desired::Stop(_)) => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desired_table_covers_every_mode_and_pairing() {
        use CloudMode::*;
        use Pairing::*;
        for mode in CloudMode::ALL {
            for pairing in [Unpaired, Revoked, Paired] {
                let want = match (mode, pairing) {
                    (No, _) => Desired::Stop(StopReason::ModeOff),
                    (_, Unpaired) => Desired::Stop(StopReason::NotPaired),
                    (_, Revoked) => Desired::Stop(StopReason::Revoked),
                    (_, Paired) => Desired::Run,
                };
                assert_eq!(desired_leg(mode, pairing), want, "{mode:?} {pairing:?}");
            }
        }
    }

    #[test]
    fn the_plan_table() {
        use CloudStep::*;
        let stop = Desired::Stop(StopReason::ModeOff);
        assert_eq!(
            plan_cloud_change(LegNow::Stopped, Desired::Run, Refresh::Keep),
            vec![StartLeg]
        );
        assert_eq!(
            plan_cloud_change(LegNow::Stopped, Desired::Run, Refresh::Restart),
            vec![StartLeg]
        );
        assert_eq!(
            plan_cloud_change(LegNow::Running, Desired::Run, Refresh::Keep),
            vec![]
        );
        assert_eq!(
            plan_cloud_change(LegNow::Running, Desired::Run, Refresh::Restart),
            vec![StopLeg, StartLeg]
        );
        assert_eq!(
            plan_cloud_change(LegNow::Running, stop, Refresh::Keep),
            vec![StopLeg]
        );
        assert_eq!(
            plan_cloud_change(LegNow::Stopped, stop, Refresh::Restart),
            vec![]
        );
    }
}
