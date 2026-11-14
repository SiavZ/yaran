//! The process-wide revocation signal: raised by any `410 machine_revoked`.
//!
//! Every signed call (the CLI, Phase 10's leg, Phase 12's emitter) goes through
//! `MachineApi`, which raises this signal and stamps `revoked_at` in the credentials.
//! Phase 10's leg subscribes so it can stop out loud on the next signed call's answer.
//!
//! - Thread-safe; `raise` never blocks on a slow subscriber (channels are unbounded,
//!   and a dropped receiver is pruned).
//!
//! <module-headers:begin>
//! <module-headers:end>

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

/// A raise counter plus subscribers.
#[derive(Default)]
pub struct RevocationSignal {
    generation: AtomicU64,
    subscribers: Mutex<Vec<Sender<u64>>>,
}

impl RevocationSignal {
    /// The one signal of this process.
    pub fn global() -> &'static RevocationSignal {
        static GLOBAL: OnceLock<RevocationSignal> = OnceLock::new();
        GLOBAL.get_or_init(RevocationSignal::default)
    }

    /// Record a revocation and notify every live subscriber with the new generation.
    pub fn raise(&self) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|tx| tx.send(generation).is_ok());
    }

    /// How many times this process has seen a revocation (0: never).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// A receiver that gets the generation on every later `raise`.
    pub fn subscribe(&self) -> Receiver<u64> {
        let (tx, rx) = mpsc::channel();
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribers_hear_every_raise_and_dropped_ones_are_pruned() {
        let signal = RevocationSignal::default();
        let rx = signal.subscribe();
        let dropped = signal.subscribe();
        drop(dropped);
        assert_eq!(signal.generation(), 0);
        signal.raise();
        signal.raise();
        assert_eq!(rx.try_recv(), Ok(1));
        assert_eq!(rx.try_recv(), Ok(2));
        assert_eq!(signal.generation(), 2);
        assert_eq!(signal.subscribers.lock().unwrap().len(), 1);
    }
}
