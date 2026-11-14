//! The cloud ingress: the live tunnel-hostname rule and the Cloudflare Access check in
//! front of every request that arrives through it (Phase 11 §1, §2, §5, §6; D2, D3, D4).
//!
//! `CloudIngress` is created unbound by every serve constructor; the cloud leg (Phase 10)
//! binds it once cloudflared is ready and unbinds it when the leg stops. While bound, a
//! request whose Host is the tunnel hostname must carry a `Cf-Access-Jwt-Assertion`
//! that verifies (RS256, the team's JWKS, `iss`, `aud`, `exp`/`nbf`) and names the
//! paired owner; anything else is refused with `Yaran-Refusal`, including a 503 when
//! the signing keys cannot be fetched. Unbound, the hostname is just an unknown Host,
//! which the Host guard refuses. Loopback, LAN and Tailscale Hosts never reach the check.
//!
//! Decision record (Phase 11 §10, threat rows T25, T26, T44, T45): every `/api/v1/*`
//! route stays unauthenticated for local callers by design, and remote access through
//! the tunnel is owner access, verified per request; so `config/raw` and the bootstrap
//! `[env]` are not restricted by origin. The owner can read those files on the machine
//! anyway, and yaran's own secrets never enter config (D5). The cost: `[env]` values and
//! edited files cross Cloudflare's edge in plaintext on every tunnel page load.
//!
//! - Trust boundary: Host and the assertion are attacker input; the token is never logged.
//! - The serve loop is the only writer (`bind`/`unbind`/`update_settings`).
//!
//! <module-headers:begin>
//! Uses:
//! cloud_ingress.rs
//! ├── cloud_jwks_cache
//! ├── handoff_csrf
//! ├── host_guard
//! ├── rate_window
//! ├── yaran-core::cloud::access_jwks
//! ├── yaran-core::cloud::access_jwt
//! ├── yaran-core::cloud::protocol
//! ├── yaran-core::cloud::protocol::rules
//! ├── yaran-core::cloud::protocol::signals
//! └── yaran-core::sanitize
//! External: axum, std, tokio, tracing
//!
//! Used by:
//! cloud_ingress.rs
//! ├── cloud_consent_tests
//! ├── cloud_handoff
//! ├── cloud_ingress_tests
//! ├── cloud_test_support
//! ├── crate
//! ├── host_guard
//! └── server
//! <module-headers:end>

use std::convert::Infallible;
use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{CloseFrame, Message};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use yaran_core::cloud::access_jwks::TeamDomain;
use yaran_core::cloud::access_jwt::{AccessRejection, Expectations, VerifiedAccess, verify};
use yaran_core::cloud::protocol::{
    REFUSAL_HEADER, RefusalCode, SESSION_EXPIRED_CLOSE_CODE, rules,
    signals::SESSION_EXPIRED_CLOSE_REASON,
};

use crate::cloud_jwks_cache::{CachePolicy, JwksCache, JwksSource, UreqJwksSource};
use crate::handoff_csrf::CsrfStore;
use crate::host_guard::normalize_host_for_match;
use crate::rate_window::RateWindow;

/// The header Cloudflare Access attaches; the `CF_Authorization` cookie is never used
/// to authorize a request.
pub const ACCESS_JWT_HEADER: &str = "cf-access-jwt-assertion";

/// The pairing-derived inputs of a binding (Phase 09's credentials).
#[derive(Debug, Clone)]
pub struct CloudBindingInput {
    pub hostname: String,
    pub team_domain: String,
    pub aud: String,
    pub owner_email: String,
}

/// A validated binding; `hostname` is normalized like the Host guard's.
#[derive(Debug, Clone)]
pub struct CloudBinding {
    pub hostname: String,
    pub team: TeamDomain,
    pub aud: String,
    pub owner_email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindRefusal {
    InvalidHostname,
    InvalidTeamDomain,
    EmptyAud,
    EmptyOwnerEmail,
}

impl BindRefusal {
    pub fn sentence(self) -> &'static str {
        match self {
            Self::InvalidHostname => {
                "the cloud hostname in the credentials is not a valid hostname, so yaran will not serve it; run `yaran cloud login` again"
            }
            Self::InvalidTeamDomain => {
                "the Access team domain in the credentials is not a cloudflareaccess.com domain, so yaran cannot verify sign-ins; run `yaran cloud login` again"
            }
            Self::EmptyAud => {
                "the credentials carry no Access application audience, so yaran cannot verify sign-ins; run `yaran cloud login` again"
            }
            Self::EmptyOwnerEmail => {
                "the credentials name no owner email, so yaran cannot tell the owner's sign-in from anyone else's; run `yaran cloud login` again"
            }
        }
    }
}

/// The live `[cloud]` settings the ingress reads per request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngressSettings {
    pub clock_skew: Duration,
    pub jwks_refresh_ceiling: Duration,
    pub jwks_retry_cooldown: Duration,
    pub handoff_per_minute: u32,
    pub close_sockets_at_access_expiry: bool,
    pub app_callback_urls: Vec<String>,
}

impl Default for IngressSettings {
    /// Phase 11 §9 defaults; `app_callback_urls` is empty until Phase 09's config supplies
    /// the compiled-in callback, so a release handoff fails closed meanwhile.
    fn default() -> Self {
        Self {
            clock_skew: Duration::from_secs(30),
            jwks_refresh_ceiling: Duration::from_secs(14_400),
            jwks_retry_cooldown: Duration::from_secs(30),
            handoff_per_minute: 12,
            close_sockets_at_access_expiry: true,
            app_callback_urls: Vec::new(),
        }
    }
}

/// The pre-warm result `bind` reports, for Phase 10's keyed status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JwksOutcome {
    Ready { keys: usize },
    Unavailable(String),
}

/// The D24 consent key, in the shape of Phase 09's `credentials::HandoffConsentKey`.
#[derive(Clone)]
pub struct ConsentKey {
    pub key: [u8; 32],
    pub version: u32,
}

/// Seam over Phase 09's `credentials::read_handoff_consent_key(&CloudPaths)`. BLOCKING;
/// called per handoff on a blocking task, never cached. `Ok(None)` means unpaired.
pub trait ConsentKeySource: Send + Sync + 'static {
    fn read_handoff_consent_key(&self) -> Result<Option<ConsentKey>, String>;
}

/// The source to use until Phase 09's credentials store is wired in: no key, so no
/// consent is ever remembered (every handoff shows the consent page).
pub struct NoConsentKey;

impl ConsentKeySource for NoConsentKey {
    fn read_handoff_consent_key(&self) -> Result<Option<ConsentKey>, String> {
        Ok(None)
    }
}

type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

struct Inner {
    binding: RwLock<Option<Arc<CloudBinding>>>,
    settings: RwLock<IngressSettings>,
    jwks: JwksCache,
    consent_keys: Arc<dyn ConsentKeySource>,
    clock: Clock,
    rate: RateWindow,
    csrf: CsrfStore,
}

/// The handle shared by the router, the Host guard and the cloud leg (cheap to clone).
#[derive(Clone)]
pub struct CloudIngress(Arc<Inner>);

impl std::fmt::Debug for CloudIngress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudIngress")
            .field("binding", &self.binding())
            .finish_non_exhaustive()
    }
}

impl Default for CloudIngress {
    fn default() -> Self {
        Self::new(Arc::new(NoConsentKey))
    }
}

impl CloudIngress {
    pub fn new(consent_keys: Arc<dyn ConsentKeySource>) -> Self {
        Self::with_parts(
            Arc::new(UreqJwksSource),
            consent_keys,
            Arc::new(SystemTime::now),
        )
    }

    pub(crate) fn with_parts(
        jwks: Arc<dyn JwksSource>,
        consent_keys: Arc<dyn ConsentKeySource>,
        clock: Clock,
    ) -> Self {
        Self(Arc::new(Inner {
            binding: RwLock::new(None),
            settings: RwLock::new(IngressSettings::default()),
            jwks: JwksCache::new(jwks),
            consent_keys,
            clock,
            rate: RateWindow::new(60),
            csrf: CsrfStore::default(),
        }))
    }

    /// Binds after cloudflared reports ready: validates, swaps the binding in, and
    /// pre-warms the JWKS on the current runtime, handing the outcome to `report`.
    pub fn bind(
        &self,
        input: CloudBindingInput,
        report: Box<dyn FnOnce(JwksOutcome) + Send>,
    ) -> Result<(), BindRefusal> {
        let hostname = normalize_host_for_match(&input.hostname)
            .filter(|h| rules::is_hostname(h) && h.parse::<std::net::IpAddr>().is_err())
            .ok_or(BindRefusal::InvalidHostname)?;
        let team = TeamDomain::parse(&input.team_domain).ok_or(BindRefusal::InvalidTeamDomain)?;
        if input.aud.trim().is_empty() {
            return Err(BindRefusal::EmptyAud);
        }
        if input.owner_email.trim().is_empty() {
            return Err(BindRefusal::EmptyOwnerEmail);
        }
        let binding = Arc::new(CloudBinding {
            hostname,
            team: team.clone(),
            aud: input.aud,
            owner_email: input.owner_email,
        });
        *self.0.binding.write().unwrap_or_else(|e| e.into_inner()) = Some(binding);
        let this = self.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => drop(rt.spawn(async move {
                let outcome = match this.0.jwks.keys(&team, this.policy()).await {
                    Ok(keys) => JwksOutcome::Ready {
                        keys: keys.kids().count(),
                    },
                    Err(e) => JwksOutcome::Unavailable(yaran_core::sanitize::for_terminal(&e)),
                };
                report(outcome);
            })),
            Err(_) => report(JwksOutcome::Unavailable(
                "no async runtime to pre-warm the Access keys on".into(),
            )),
        }
        Ok(())
    }

    /// Clears the binding (leg stop, revocation, mode `no`). Idempotent.
    pub fn unbind(&self) {
        *self.0.binding.write().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Applies changed `[cloud]` keys live (both reload owners call this).
    pub fn update_settings(&self, settings: IngressSettings) {
        *self.0.settings.write().unwrap_or_else(|e| e.into_inner()) = settings;
    }

    pub fn binding(&self) -> Option<Arc<CloudBinding>> {
        self.0
            .binding
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn settings(&self) -> IngressSettings {
        self.0
            .settings
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Whether a raw Host value is the bound tunnel hostname.
    pub fn is_bound_host(&self, host_header: &str) -> bool {
        self.bound_for(host_header).is_some()
    }

    fn bound_for(&self, host_header: &str) -> Option<Arc<CloudBinding>> {
        let host = normalize_host_for_match(host_header)?;
        self.binding().filter(|b| b.hostname == host)
    }

    pub(crate) fn now(&self) -> SystemTime {
        (self.0.clock)()
    }

    pub(crate) fn now_secs(&self) -> i64 {
        self.now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64)
    }

    pub(crate) fn csrf(&self) -> &CsrfStore {
        &self.0.csrf
    }

    pub(crate) fn rate(&self) -> &RateWindow {
        &self.0.rate
    }

    fn policy(&self) -> CachePolicy {
        let s = self.settings();
        CachePolicy {
            refresh_ceiling: s.jwks_refresh_ceiling,
            retry_cooldown: s.jwks_retry_cooldown,
        }
    }

    /// Verifies `token` for `binding`, refetching the keys once on an unknown `kid`.
    pub(crate) async fn verify_token(
        &self,
        binding: &CloudBinding,
        token: &str,
    ) -> Result<VerifiedAccess, RefusalCode> {
        if token.is_empty() {
            return Err(AccessRejection::Missing.refusal());
        }
        let expect = Expectations {
            team: binding.team.clone(),
            aud: binding.aud.clone(),
            owner_email: binding.owner_email.clone(),
            skew: self.settings().clock_skew,
        };
        let unavailable = |_| RefusalCode::AccessKeysUnavailable;
        let keys = self
            .0
            .jwks
            .keys(&binding.team, self.policy())
            .await
            .map_err(unavailable)?;
        match verify(token, &keys, &expect, self.now()) {
            Err(AccessRejection::UnknownKid) => {
                let keys = self
                    .0
                    .jwks
                    .refetch_for_unknown_kid(&binding.team, self.policy())
                    .await
                    .map_err(unavailable)?;
                verify(token, &keys, &expect, self.now()).map_err(AccessRejection::refusal)
            }
            other => other.map_err(AccessRejection::refusal),
        }
    }

    /// Reads the D24 consent key on a blocking task; a failure is logged and treated as
    /// no key (the consent page is shown).
    pub(crate) async fn consent_key(&self) -> Option<ConsentKey> {
        let source = Arc::clone(&self.0.consent_keys);
        match tokio::task::spawn_blocking(move || source.read_handoff_consent_key()).await {
            Ok(Ok(key)) => key,
            Ok(Err(e)) => {
                tracing::warn!(target: "yaran::cloud::handoff", error = %yaran_core::sanitize::for_terminal(&e), "could not read the handoff consent key; showing the consent page");
                None
            }
            Err(_) => None,
        }
    }
}

/// A plain-text refusal carrying `Yaran-Refusal` and `no-store`.
pub(crate) fn refusal_response(code: RefusalCode, body: String) -> Response {
    let status = StatusCode::from_u16(code.status()).unwrap_or(StatusCode::FORBIDDEN);
    let mut response = (status, body).into_response();
    let headers = response.headers_mut();
    headers.insert(REFUSAL_HEADER, HeaderValue::from_static(code.as_str()));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn refusal_sentence(code: RefusalCode, binding: &CloudBinding) -> String {
    match code {
        RefusalCode::AccessKeysUnavailable => format!(
            "yaran could not fetch the Cloudflare Access signing keys for {}; refusing the request until it can",
            binding.team.host()
        ),
        RefusalCode::AccessNotOwner => {
            "this machine accepts only its paired owner's Cloudflare Access sign-in".to_string()
        }
        other => format!("Cloudflare Access sign-in required ({})", other.as_str()),
    }
}

/// Middleware: on the bound tunnel hostname, require a verified owner assertion and
/// attach it (and the socket deadline) as request extensions; every other Host passes.
pub(crate) async fn cloud_access_middleware(
    State(ingress): State<CloudIngress>,
    mut request: Request,
    next: Next,
) -> Response {
    let binding = request
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| ingress.bound_for(h));
    let Some(binding) = binding else {
        return next.run(request).await;
    };
    let token = request
        .headers()
        .get(ACCESS_JWT_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    match ingress.verify_token(&binding, &token).await {
        Ok(access) => {
            let settings = ingress.settings();
            let deadline = settings.close_sockets_at_access_expiry.then(|| {
                let left = (access.exp + settings.clock_skew)
                    .duration_since(ingress.now())
                    .unwrap_or_default();
                tokio::time::Instant::now() + left
            });
            request.extensions_mut().insert(SessionDeadline(deadline));
            request.extensions_mut().insert(access);
            next.run(request).await
        }
        Err(code) => {
            tracing::warn!(target: "yaran::cloud::ingress", code = code.as_str(), "refused a request on the cloud hostname");
            refusal_response(code, refusal_sentence(code, &binding))
        }
    }
}

/// When a socket opened under an Access JWT must close (`exp + skew`), or `None`.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SessionDeadline(pub Option<tokio::time::Instant>);

impl<S: Send + Sync> FromRequestParts<S> for SessionDeadline {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Infallible> {
        Ok(parts.extensions.get::<Self>().copied().unwrap_or_default())
    }
}

/// Resolves at the deadline; never resolves for `None`.
pub(crate) async fn session_deadline(at: Option<tokio::time::Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// The close a socket sends when its Access session expires (4401).
pub(crate) fn session_expired_close() -> Message {
    Message::Close(Some(CloseFrame {
        code: SESSION_EXPIRED_CLOSE_CODE,
        reason: SESSION_EXPIRED_CLOSE_REASON.into(),
    }))
}
