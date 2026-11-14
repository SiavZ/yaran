//! A process-wide fixed-window request counter (Phase 11 §7), the first rate limiter in
//! yaran-web.
//!
//! Counts admissions per window of whole seconds and answers how long to wait when the
//! window is full. Per-client limiting is impossible behind the tunnel (every request
//! arrives from loopback), so one counter guards the whole route.
//!
//! - The clock is injected (unix seconds), so tests drive window roll-over directly.
//! - The limit is passed per call, so a live config change applies to the next request.
//!
//! <module-headers:begin>
//! Uses: none
//! External: std
//!
//! Used by:
//! rate_window.rs
//! └── cloud_ingress
//! <module-headers:end>

use std::sync::Mutex;

#[derive(Debug)]
pub(crate) struct RateWindow {
    window_secs: u64,
    /// (window start, admissions in it); `None` until the first request.
    state: Mutex<Option<(u64, u32)>>,
}

impl RateWindow {
    pub(crate) fn new(window_secs: u64) -> Self {
        Self {
            window_secs: window_secs.max(1),
            state: Mutex::new(None),
        }
    }

    /// Admits one request at `now`, or returns the whole seconds until the window
    /// rolls over (at least 1, the `Retry-After` value).
    pub(crate) fn try_admit(&self, now: u64, limit: u32) -> Result<(), u64> {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let state = guard.get_or_insert((now, 0));
        if now >= state.0 + self.window_secs || now < state.0 {
            *state = (now, 0);
        }
        if state.1 >= limit {
            return Err((state.0 + self.window_secs).saturating_sub(now).max(1));
        }
        state.1 += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::RateWindow;

    #[test]
    fn the_exact_limit_is_admitted_and_the_next_one_waits_for_the_roll_over() {
        let w = RateWindow::new(60);
        for _ in 0..12 {
            assert_eq!(w.try_admit(1_000, 12), Ok(()));
        }
        assert_eq!(w.try_admit(1_000, 12), Err(60));
        assert_eq!(w.try_admit(1_045, 12), Err(15));
        assert_eq!(w.try_admit(1_059, 12), Err(1));
        assert_eq!(w.try_admit(1_060, 12), Ok(()), "a new window opens");
    }

    #[test]
    fn a_zero_limit_admits_nothing_and_a_raised_limit_applies_at_once() {
        let w = RateWindow::new(60);
        assert_eq!(w.try_admit(5, 0), Err(60));
        assert_eq!(w.try_admit(5, 1), Ok(()));
    }

    #[test]
    fn a_clock_that_steps_back_starts_a_fresh_window() {
        let w = RateWindow::new(60);
        assert_eq!(w.try_admit(500, 1), Ok(()));
        assert_eq!(w.try_admit(400, 1), Ok(()));
    }
}
