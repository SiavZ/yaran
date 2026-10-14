//! A conditional read-modify-write on an `AtomicUsize`, spelled out.
//!
//! `AtomicUsize::fetch_update` is deprecated from Rust 1.99 in favour of
//! `try_update`, which does not exist on the 1.88 MSRV, so neither name builds
//! warning-free on both toolchains CI runs. This is the same compare-exchange
//! loop the standard library runs for both, with the semantics unchanged:
//! `f` sees the current value and returns the new one, or `None` to leave it
//! alone; the result is `Ok(previous)` when the value was replaced and
//! `Err(current)` when `f` declined.

use std::sync::atomic::{AtomicUsize, Ordering};

/// Apply `f` to `counter` atomically, with relaxed ordering on both the
/// success and the failure path. `f` may run more than once when other
/// threads change the value meanwhile, so it must be a pure function of its
/// argument.
pub fn update_relaxed(
    counter: &AtomicUsize,
    mut f: impl FnMut(usize) -> Option<usize>,
) -> Result<usize, usize> {
    let mut current = counter.load(Ordering::Relaxed);
    while let Some(next) = f(current) {
        match counter.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(previous) => return Ok(previous),
            Err(actual) => current = actual,
        }
    }
    Err(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn replaces_the_value_and_returns_the_previous_one() {
        let counter = AtomicUsize::new(3);
        assert_eq!(update_relaxed(&counter, |n| Some(n + 1)), Ok(3));
        assert_eq!(counter.load(Ordering::Relaxed), 4);
    }

    #[test]
    fn a_declined_update_leaves_the_value_and_reports_it() {
        let counter = AtomicUsize::new(7);
        assert_eq!(update_relaxed(&counter, |_| None), Err(7));
        assert_eq!(counter.load(Ordering::Relaxed), 7);
    }

    #[test]
    fn a_saturating_decrement_stops_at_zero() {
        let counter = AtomicUsize::new(0);
        assert_eq!(
            update_relaxed(&counter, |n| Some(n.saturating_sub(1))),
            Ok(0)
        );
        assert_eq!(counter.load(Ordering::Relaxed), 0);
    }

    /// Many threads racing a capped increment: exactly `cap` succeed, so the
    /// loop never lets two callers claim the same slot.
    #[test]
    fn concurrent_capped_increments_never_overshoot() {
        const CAP: usize = 50;
        let counter = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let counter = Arc::clone(&counter);
                std::thread::spawn(move || {
                    (0..100)
                        .filter(|_| {
                            update_relaxed(&counter, |n| (n < CAP).then_some(n + 1)).is_ok()
                        })
                        .count()
                })
            })
            .collect();
        let won: usize = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(won, CAP);
        assert_eq!(counter.load(Ordering::Relaxed), CAP);
    }
}
