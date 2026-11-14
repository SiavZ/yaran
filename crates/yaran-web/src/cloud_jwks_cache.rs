//! The Access signing-key cache behind the cloud ingress (Phase 11 §4).
//!
//! One `tokio::sync::Mutex` makes every fetch single-flight: concurrent misses queue on
//! the lock and find the keys the first one fetched. The fetch itself runs on a blocking
//! task, never a reactor thread. Keys are refreshed at `min(max-age, ceiling)` with a
//! 300 s floor; an unknown `kid` triggers a refetch at most once per cooldown (rotation
//! keeps the old key for 7 days); a failed refresh keeps serving the stale keys, and an
//! empty cache whose fetch failed (or is cooling down) answers `Unavailable`, which the
//! ingress turns into a 503. It never lets a request through without keys.
//!
//! - Time is `tokio::time::Instant`, so tests run on a paused clock.
//! - `JwksSource` is the network seam: ureq in production, fixtures in tests.
//!
//! <module-headers:begin>
//! Uses:
//! cloud_jwks_cache.rs
//! └── yaran-core::cloud::access_jwks
//! External: std, tokio, tracing
//!
//! Used by:
//! cloud_jwks_cache.rs
//! ├── cloud_ingress
//! ├── cloud_test_support
//! └── crate
//! <module-headers:end>

use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;
use yaran_core::cloud::access_jwks::{Jwks, TeamDomain, fetch_jwks};

/// The shortest refresh interval, whatever `max-age` or the ceiling say.
pub(crate) const REFRESH_FLOOR: Duration = Duration::from_secs(300);
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// A fetch result: the keys and the response's `max-age`, or a sanitized error.
pub type Fetched = Result<(Jwks, Option<Duration>), String>;

/// Where keys come from. BLOCKING: the cache calls it on a blocking task.
pub trait JwksSource: Send + Sync + 'static {
    fn fetch(&self, team: &TeamDomain) -> Fetched;
}

/// The production source: one ureq GET of the team's certs endpoint.
pub struct UreqJwksSource;

impl JwksSource for UreqJwksSource {
    fn fetch(&self, team: &TeamDomain) -> Fetched {
        fetch_jwks(team, FETCH_TIMEOUT)
    }
}

/// The cache's timing knobs, taken from the live ingress settings per call.
#[derive(Debug, Clone, Copy)]
pub(crate) struct CachePolicy {
    pub refresh_ceiling: Duration,
    pub retry_cooldown: Duration,
}

#[derive(Default)]
struct CacheState {
    team: Option<TeamDomain>,
    keys: Option<Arc<Jwks>>,
    fresh_until: Option<Instant>,
    last_attempt: Option<Instant>,
    last_error: Option<String>,
}

pub(crate) struct JwksCache {
    source: Arc<dyn JwksSource>,
    state: tokio::sync::Mutex<CacheState>,
}

impl JwksCache {
    pub(crate) fn new(source: Arc<dyn JwksSource>) -> Self {
        Self {
            source,
            state: tokio::sync::Mutex::new(CacheState::default()),
        }
    }

    /// The keys to verify with: cached while fresh, refreshed when stale (stale keys
    /// are kept if the refresh fails), fetched when empty.
    pub(crate) async fn keys(
        &self,
        team: &TeamDomain,
        policy: CachePolicy,
    ) -> Result<Arc<Jwks>, String> {
        let mut state = self.state.lock().await;
        self.reset_for(&mut state, team);
        let stale = state.fresh_until.is_none_or(|t| Instant::now() >= t);
        if stale {
            self.fetch_unless_cooling(&mut state, team, policy).await;
        }
        Self::answer(&state)
    }

    /// After an unknown `kid`: refetch unless a fetch ran within the cooldown, then
    /// answer with whatever keys are held.
    pub(crate) async fn refetch_for_unknown_kid(
        &self,
        team: &TeamDomain,
        policy: CachePolicy,
    ) -> Result<Arc<Jwks>, String> {
        let mut state = self.state.lock().await;
        self.reset_for(&mut state, team);
        self.fetch_unless_cooling(&mut state, team, policy).await;
        Self::answer(&state)
    }

    fn reset_for(&self, state: &mut CacheState, team: &TeamDomain) {
        if state.team.as_ref() != Some(team) {
            *state = CacheState {
                team: Some(team.clone()),
                ..CacheState::default()
            };
        }
    }

    fn answer(state: &CacheState) -> Result<Arc<Jwks>, String> {
        state.keys.clone().ok_or_else(|| {
            state
                .last_error
                .clone()
                .unwrap_or_else(|| "no fetch has succeeded yet".to_string())
        })
    }

    async fn fetch_unless_cooling(
        &self,
        state: &mut CacheState,
        team: &TeamDomain,
        policy: CachePolicy,
    ) {
        let now = Instant::now();
        if state
            .last_attempt
            .is_some_and(|t| now < t + policy.retry_cooldown)
        {
            return;
        }
        state.last_attempt = Some(now);
        let source = Arc::clone(&self.source);
        let fetch_team = team.clone();
        let outcome = tokio::task::spawn_blocking(move || source.fetch(&fetch_team))
            .await
            .unwrap_or_else(|e| Err(format!("the JWKS fetch task failed: {e}")));
        match outcome {
            Ok((jwks, max_age)) => {
                let ttl = max_age
                    .map_or(policy.refresh_ceiling, |m| m.min(policy.refresh_ceiling))
                    .max(REFRESH_FLOOR);
                state.keys = Some(Arc::new(jwks));
                state.fresh_until = Some(Instant::now() + ttl);
                state.last_error = None;
            }
            Err(error) => {
                tracing::warn!(
                    target: "yaran::cloud::jwks",
                    team = %team.host(),
                    error = %yaran_core::sanitize::for_terminal(&error),
                    kept_stale_keys = state.keys.is_some(),
                    "could not fetch the Cloudflare Access signing keys"
                );
                state.last_error = Some(error);
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// Serves the queued answers in order (the last one repeats) and counts fetches.
    pub(crate) struct FakeSource {
        pub answers: Mutex<Vec<Fetched>>,
        pub fetches: AtomicUsize,
    }

    impl FakeSource {
        pub(crate) fn new(answers: Vec<Fetched>) -> Arc<Self> {
            Arc::new(Self {
                answers: Mutex::new(answers),
                fetches: AtomicUsize::new(0),
            })
        }
    }

    impl JwksSource for FakeSource {
        fn fetch(&self, _team: &TeamDomain) -> Fetched {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            let mut answers = self.answers.lock().unwrap();
            if answers.len() > 1 {
                answers.remove(0)
            } else {
                answers[0].clone()
            }
        }
    }

    pub(crate) fn fixture_jwks(name: &str) -> Jwks {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../cloud/protocol/fixtures/access-jwt/"
        );
        Jwks::parse(&std::fs::read_to_string(format!("{path}{name}")).unwrap()).unwrap()
    }

    fn team() -> TeamDomain {
        TeamDomain::parse("fixture-team.cloudflareaccess.com").unwrap()
    }

    const POLICY: CachePolicy = CachePolicy {
        refresh_ceiling: Duration::from_secs(14_400),
        retry_cooldown: Duration::from_secs(30),
    };

    #[tokio::test(start_paused = true)]
    async fn fifty_concurrent_misses_cause_one_fetch() {
        let source = FakeSource::new(vec![Ok((fixture_jwks("jwks.json"), None))]);
        let cache = Arc::new(JwksCache::new(source.clone()));
        let calls = (0..50).map(|_| {
            let cache = Arc::clone(&cache);
            tokio::spawn(async move { cache.keys(&team(), POLICY).await.is_ok() })
        });
        for call in calls {
            assert!(call.await.unwrap());
        }
        assert_eq!(source.fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn unknown_kid_refetches_stop_at_the_cooldown() {
        let source = FakeSource::new(vec![Ok((fixture_jwks("jwks.json"), None))]);
        let cache = JwksCache::new(source.clone());
        cache.keys(&team(), POLICY).await.unwrap();
        for _ in 0..5 {
            cache
                .refetch_for_unknown_kid(&team(), POLICY)
                .await
                .unwrap();
        }
        assert_eq!(source.fetches.load(Ordering::SeqCst), 1);
        tokio::time::advance(Duration::from_secs(30)).await;
        cache
            .refetch_for_unknown_kid(&team(), POLICY)
            .await
            .unwrap();
        assert_eq!(source.fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_honours_max_age_the_ceiling_and_the_floor() {
        let max_age = |s| Ok((fixture_jwks("jwks.json"), Some(Duration::from_secs(s))));
        let source = FakeSource::new(vec![max_age(60), max_age(99_999)]);
        let cache = JwksCache::new(source.clone());
        cache.keys(&team(), POLICY).await.unwrap();
        tokio::time::advance(Duration::from_secs(299)).await;
        cache.keys(&team(), POLICY).await.unwrap();
        assert_eq!(source.fetches.load(Ordering::SeqCst), 1, "300 s floor");
        tokio::time::advance(Duration::from_secs(1)).await;
        cache.keys(&team(), POLICY).await.unwrap();
        assert_eq!(source.fetches.load(Ordering::SeqCst), 2);
        tokio::time::advance(Duration::from_secs(14_399)).await;
        cache.keys(&team(), POLICY).await.unwrap();
        assert_eq!(
            source.fetches.load(Ordering::SeqCst),
            2,
            "ceiling caps max-age"
        );
        tokio::time::advance(Duration::from_secs(1)).await;
        cache.keys(&team(), POLICY).await.unwrap();
        assert_eq!(source.fetches.load(Ordering::SeqCst), 3);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_keys_are_served_while_a_refresh_fails() {
        let source = FakeSource::new(vec![
            Ok((fixture_jwks("jwks.json"), None)),
            Err("offline".into()),
        ]);
        let cache = JwksCache::new(source.clone());
        cache.keys(&team(), POLICY).await.unwrap();
        tokio::time::advance(Duration::from_secs(14_400)).await;
        let keys = cache.keys(&team(), POLICY).await.unwrap();
        assert!(keys.get("fixture-current").is_some());
        assert_eq!(source.fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_cache_with_a_failed_fetch_is_unavailable_and_cools_down() {
        let source = FakeSource::new(vec![Err("dns failure".into())]);
        let cache = JwksCache::new(source.clone());
        assert_eq!(
            cache.keys(&team(), POLICY).await.unwrap_err(),
            "dns failure"
        );
        assert!(cache.keys(&team(), POLICY).await.is_err());
        assert_eq!(source.fetches.load(Ordering::SeqCst), 1, "cooldown");
        tokio::time::advance(Duration::from_secs(30)).await;
        assert!(cache.keys(&team(), POLICY).await.is_err());
        assert_eq!(source.fetches.load(Ordering::SeqCst), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn a_different_team_starts_from_empty() {
        let source = FakeSource::new(vec![Ok((fixture_jwks("jwks.json"), None))]);
        let cache = JwksCache::new(source.clone());
        cache.keys(&team(), POLICY).await.unwrap();
        let other = TeamDomain::parse("other.cloudflareaccess.com").unwrap();
        cache.keys(&other, POLICY).await.unwrap();
        assert_eq!(source.fetches.load(Ordering::SeqCst), 2);
    }
}
