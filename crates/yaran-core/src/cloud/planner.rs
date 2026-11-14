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
//! Uses:
//! cloud/planner.rs
//! └── cloud::leg_seam
//! External: none
//!
//! Used by:
//! cloud/planner.rs
//! └── cloud
//! <module-headers:end>

use super::leg_seam::CloudMode;

/// What the credentials say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pairing {
    Unpaired,
    Revoked,
    Paired,
}

/// Why the leg should not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    ModeOff,
    NotPaired,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired {
    Run,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudStep {
    StopLeg,
    StartLeg,
}

/// The steps from `running` to `desired`. `restart` asks for a fresh child even when one
/// runs (new credentials or changed `[cloud]` keys).
pub fn plan_cloud_change(running: bool, desired: Desired, restart: bool) -> Vec<CloudStep> {
    match (running, desired) {
        (true, Desired::Run) if restart => vec![CloudStep::StopLeg, CloudStep::StartLeg],
        (true, Desired::Run) => vec![],
        (false, Desired::Run) => vec![CloudStep::StartLeg],
        (true, Desired::Stop(_)) => vec![CloudStep::StopLeg],
        (false, Desired::Stop(_)) => vec![],
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
            plan_cloud_change(false, Desired::Run, false),
            vec![StartLeg]
        );
        assert_eq!(plan_cloud_change(false, Desired::Run, true), vec![StartLeg]);
        assert_eq!(plan_cloud_change(true, Desired::Run, false), vec![]);
        assert_eq!(
            plan_cloud_change(true, Desired::Run, true),
            vec![StopLeg, StartLeg]
        );
        assert_eq!(plan_cloud_change(true, stop, false), vec![StopLeg]);
        assert_eq!(plan_cloud_change(false, stop, true), vec![]);
    }
}
