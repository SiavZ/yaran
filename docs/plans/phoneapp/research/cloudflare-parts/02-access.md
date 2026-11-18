# 02 — Cloudflare Access (self-hosted apps, policies, service tokens, plan limits)

Researched 2026-11-14. Doc "last updated" dates noted where the page shows one. Anything marked **UNVERIFIED** could not be confirmed from an official Cloudflare source.

Key source URLs (referenced by short tag below):

- [API-APP] https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/ (API reference, no date)
- [TS-SDK] https://cdn.jsdelivr.net/npm/cloudflare@5/src/resources/zero-trust/access/applications/applications.ts (Stainless-generated cloudflare-typescript, used for exact field names)
- [API-POL] https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/policies/methods/create/
- [API-ST] https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/methods/create/
- [API-ORG] https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/
- [API-IDP] https://developers.cloudflare.com/api/resources/zero_trust/subresources/identity_providers/methods/list/
- [LIMITS] https://developers.cloudflare.com/cloudflare-one/account-limits/ (updated 2026-11-05)
- [SELFHOST] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ (updated 2026-04-17)
- [PATHS] https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ (updated 2026-04-17)
- [POLICIES] https://developers.cloudflare.com/cloudflare-one/access-controls/policies/ (updated 2026-11-02)
- [POLMGMT] https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/ (updated 2026-11-02)
- [CORS] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/ (updated 2026-11-02)
- [COOKIE] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ (updated 2026-11-02)
- [JWT] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (updated 2026-11-02)
- [OAUTH] https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ (updated 2026-11-03; launched in changelog https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/)
- [STRICT] https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/ (2026-10-02)
- [ST] https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ (updated 2026-11-11)
- [WORKERS] https://developers.cloudflare.com/workers/configuration/cloudflare-access/ (updated 2026-11-02)
- [OTP] https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/ (updated 2026-08-31)
- [CFIDP] https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/ (updated 2026-06-19); changelog https://developers.cloudflare.com/changelog/post/2026-06-18-cloudflare-idp-default/
- [SEATS] https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/ (updated 2026-05-01)
- [SETUP] https://developers.cloudflare.com/cloudflare-one/setup/ (updated 2026-10-12)
- [PLANS] https://www.cloudflare.com/plans/sase-zero-trust.md
- [TUNFAQ] https://developers.cloudflare.com/cloudflare-one/faq/tunnel/

---

## 1. Create a self-hosted application

`POST https://api.cloudflare.com/client/v4/accounts/{account_id}/access/apps` [API-APP]
(Also exists zone-scoped: `/zones/{zone_id}/access/apps`.) Token permission: "Access: Apps and Policies Write" [POLMGMT], [OAUTH].

Body fields for `type: "self_hosted"` [API-APP], names cross-checked against [TS-SDK]:

| Field | Type | Notes |
|---|---|---|
| `type` | `"self_hosted"` | required |
| `domain` | string | **required**. "Primary hostname and path secured by Access." Shown in App Launcher if visible. |
| `name` | string | |
| `destinations` | array | Supersedes `self_hosted_domains` (deprecated, supported until 2025-11-21, ignored if `destinations` given). |
| `session_duration` | string | "The amount of time that tokens issued for this application will be valid. Must be in the format 300ms or 2h45m." |
| `auto_redirect_to_identity` | bool | Skips IdP selection; "requires exactly one IdP in `allowed_idps`". |
| `allowed_idps` | string[] (IdP UUIDs) | Defaults to all IdPs in the account. |
| `app_launcher_visible` | bool | |
| `cors_headers` | object | see below |
| `same_site_cookie_attribute` | string | `none` / `lax` / `strict` per [COOKIE] (strict can cause `ERR_TOO_MANY_REDIRECTS`). |
| `http_only_cookie_attribute` | bool | HttpOnly on by default per [COOKIE]. |
| `enable_binding_cookie` | bool | Adds `CF_Binding` cookie; avoid for non-browser clients [COOKIE]. |
| `path_cookie_attribute` | bool | Scope app JWT cookie to app path instead of hostname. |
| `eager_redirect_cookie_setting` | bool | Default true; sets cookie on every hostname of a multi-domain app during login redirect chain. |
| `allow_authenticate_via_warp` | bool | Overrides org setting. |
| `allow_iframe` | bool | |
| `options_preflight_bypass` | bool | OPTIONS preflights skip Access and go to origin. **Cannot be enabled if `cors_headers` is set.** |
| `skip_interstitial` | bool | "Enables automatic authentication through cloudflared." |
| `service_auth_401_redirect` | bool | "Returns a 401 status code when the request is blocked by a Service Auth policy." |
| `read_service_tokens_from_header` | string | Header name carrying JSON `{"cf-access-client-id":..,"cf-access-client-secret":..}` [ST]. |
| `policies` | array | Ascending precedence. **Reusable and inline policies are mutually exclusive.** |
| `custom_deny_message`, `custom_deny_url`, `custom_non_identity_deny_url`, `custom_pages`, `logo_url`, `tags`, `mfa_config`, `oauth_configuration` (beta), `scim_config` (closed beta) | | |

`cors_headers` subfields [API-APP]: `allow_all_headers` (bool), `allow_all_methods` (bool), `allow_all_origins` (bool), `allow_credentials` (bool), `allowed_headers` (string[]), `allowed_methods` (subset of GET, POST, HEAD, PUT, DELETE, CONNECT, OPTIONS, TRACE, PATCH), `allowed_origins` (string[]), `max_age` (number, -1..86400).

`destinations[]` item types [API-APP]:
- Public: `{"type":"public","uri":"host.example.com/optional/path","overrides":[...]}`. "Wildcards are allowed." The `uri` implicitly covers subpaths.
- Private: `{"type":"private","cidr","hostname","l4_protocol","port_range","vnet_id"}`.
- `worker` / `preview_worker` (`worker_id`), `all_workers` / `all_preview_workers` (at most one per account), `via_mcp_server_portal`.
- `overrides`: `{"behavior":"public","path_pattern":"..."}` — bypasses Access on matching paths; ≤512 chars, one `*` per segment, does NOT implicitly cover subpaths.

Multiple destinations: an app holds many; limit **50 domains per application** [LIMITS].

Wildcard/path semantics [PATHS]: `*` in a subdomain matches exactly one label (`*.example.com` ≠ `example.com` ≠ `a.b.example.com`); `example.com` and `example.com/*` both cover all paths; `example.com/alpha/*` does not cover `/alpha` itself; at most one `*` per label/segment; ports, query strings and `#` fragments are not supported in paths. More specific path apps take precedence over less specific ones and do not inherit.

`policies[]` shape [API-APP]: link form `{"id":"<uuid>","precedence":1}` (precedence unique per app) or a bare UUID string; inline form also exists (legacy, see §2).

Response: `result` includes `id`, `aud` ("Audience tag."), `domain`, `destinations`, `policies`, and the settings above [TS-SDK]. The AUD tag "doesn't change unless you delete or recreate the application" [JWT].

Example minimal body (assembled from the documented fields, not copied from a doc example):

```json
{
  "type": "self_hosted",
  "name": "dev-mac-01",
  "domain": "dev-mac-01.example.com",
  "destinations": [{"type": "public", "uri": "dev-mac-01.example.com"}],
  "session_duration": "24h",
  "app_launcher_visible": false,
  "policies": [{"id": "<reusable-policy-uuid>", "precedence": 1}]
}
```

Deploy-order warning: "If you publish a tunnel route before creating an Access application, the app is reachable by anyone on the Internet." [SELFHOST] Access is "deny by default" [SELFHOST].

## 2. Policies

Reusable policy: `POST /accounts/{account_id}/access/policies` [API-POL]. Body:
- `name` (required), `decision` (required) ∈ `"allow" | "deny" | "non_identity" | "bypass"` (dashboard labels: Allow, Block, Service Auth, Bypass [POLICIES]).
- `include` (required, OR), `exclude` (NOT), `require` (AND).
- `session_duration` (e.g. `"24h"`), `approval_required`, `approval_groups`, `purpose_justification_*`, `isolation_required`, `mfa_config`, `connection_rules`.
- Response `result`: `id`, `account_id`, `app_count`, …

Rule shapes [API-POL]:
- Email: `{"email":{"email":"user@example.com"}}`
- Email domain: `{"email_domain":{"domain":"example.com"}}`
- Specific service token: `{"service_token":{"token_id":"<service-token-uuid>"}}`
- Any valid service token: `{"any_valid_service_token":{}}`
- Everyone: `{"everyone":{}}`

Semantics [POLICIES]: Service Token / Any Access Service Token selectors **require the Service Auth action** (`non_identity`). Emails is identity-based, checked at login only; service token selectors are checked at login and continuously. Bypass disables enforcement and logging and can't use identity selectors.

So an owner-only + machine setup needs two policies on the app: one `allow` with the email include, and (if service tokens are used) a separate `non_identity` policy with the service_token include.

Reusable vs legacy [POLMGMT]: legacy policies are app-scoped; they "cannot be added to newly created Access applications". Convert: `PUT /accounts/{id}/access/apps/{app_id}/policies/{policy_id}/make_reusable` (empty body); afterwards manage via `/access/policies/{policy_id}`. Note [API-APP] still documents an inline policy form in `policies[]`; whether the API accepts inline policies on newly created apps is **UNVERIFIED** given the POLMGMT statement — use reusable policies. Reusable changes apply to every app using the policy, so a per-developer email policy means one reusable policy per developer (or per app).

Limits (default, per account) [LIMITS]: applications **500**; reusable policies **500**; rule groups 300; rules per rule group 1,000; rules per application 1,000; email addresses per rule 1,000; domains per application 50; service tokens **50**; identity providers 50. Enterprise can request increases. Per-developer app + per-developer policy ⇒ ~500 developers per account ceiling (policy and app limits both 500).

## 3. Unauthenticated request behaviour

- Browser navigation: redirect to login on the team domain; global session cookie lives on `<team>.cloudflareaccess.com`, app token cookie `CF_Authorization` on the app hostname [COOKIE]. Exact 302 target URL format **UNVERIFIED** (not spelled out on the pages read).
- Non-browser clients (default): get a `302` to a login page they cannot complete [OAUTH].
- Managed OAuth enabled (`oauth_configuration.enabled`): non-browser clients get **`401` with `WWW-Authenticate`** pointing to `https://<app-domain>/.well-known/oauth-authorization-server` (RFC 8414 / RFC 9728); auth-code flow in the system browser; opaque access tokens (`oauth:...`), default lifetime 15 min, refresh via grant session; dynamic client registration with localhost/loopback options and an allowlist of redirect URIs, including exact-match private-use URI schemes for native apps; client must support RFC 8707 (resource indicators); supported on self-hosted apps [OAUTH]. Exact header the client uses to present the token (presumably `Authorization: Bearer`) **UNVERIFIED**; PKCE not mentioned on the page (**UNVERIFIED**). Beta per [API-APP].
- How Access decides "browser" vs "non-browser": **UNVERIFIED** — no official page states the heuristic. A third-party course page claims `Accept: application/json` gets 401 (not official).
- `service_auth_401_redirect`: returns 401 when blocked by a Service Auth policy [API-APP].
- Strict service token auth (org setting, `strict_service_token_auth`): failures with service token headers return 401/403 instead of 302; only Service Auth policies authorize; no `CF_Authorization` cookie issued; any sent cookie ignored. **On by default and cannot be disabled for orgs created on/after 2026-10-05.** Toggle `PATCH /accounts/{id}/access/organizations {"strict_service_token_auth":true}` [STRICT], [API-ORG].
- Org field `warp_auth_non_browser_401`: 401 instead of login redirect for unsuccessful non-browser WARP requests [API-ORG].
- fetch/XHR and CORS [CORS]: Access requires a valid cookie on CORS requests. Unauthenticated simple requests fail as a CORS error. Preflight OPTIONS gets **403 even when logged in** (browsers don't send cookies on OPTIONS) unless you enable either `options_preflight_bypass` (origin must then enforce CORS) or `cors_headers` (Cloudflare answers the preflight). Same-origin apps should use `credentials: 'same-origin'`. Cross-origin cookie use also needs `same_site_cookie_attribute: "none"` [COOKIE].
- WebSockets: Cloudflare Tunnel has "full support for Websockets" [TUNFAQ]. [WORKERS] says Worker-level Access "do[es] not currently support WebSocket connections" (upgrade → 403) and directs WebSocket Workers to "use a hostname-based Access application instead", which implies hostname-based apps pass WebSocket upgrades. No official page states that the `CF_Authorization` cookie (or service token headers) must be on the upgrade request, though [COOKIE] says Access blocks any request lacking a valid cookie. Upgrade-time auth behaviour: **UNVERIFIED** (test it). Browser `WebSocket` cannot set custom headers, so browsers rely on the cookie; native clients can send headers.

## 4. Service tokens

- Create: `POST /accounts/{account_id}/access/service_tokens` body `{"name":"...","duration":"8760h"}` (+ `tags`) [ST], [API-ST]. `duration` accepts Go durations or `"forever"`; default 1 year (8760h) [API-ST].
- Response: `id`, `client_id`, `client_secret` (**shown only once**), `duration`, `expires_at` [ST] (API reference example omits `expires_at` [API-ST]), `client_secret_version`. New secrets from 2026-08-26 look like `cfast_` + 40 alnum + 8-char checksum; old 64-hex secrets still work [ST].
- Headers: `CF-Access-Client-Id` and `CF-Access-Client-Secret` on every request [ST].
- Single header: set app's `read_service_tokens_from_header` (e.g. `"Authorization"`); client sends JSON `{"cf-access-client-id":"...","cf-access-client-secret":"..."}` in it [ST].
- Refresh: `POST /access/service_tokens/{id}/refresh` (+1 year). Rotate: `POST .../rotate` with optional `previous_client_secret_expires_at` (grace 1h–30d; omit = revoke now) [ST]. Expiry notification "Expiring Access Service Token" one week before [ST]. Org `service_token_inactivity` can act on idle tokens [API-ORG].
- Cookie after service-token auth: none under strict mode [STRICT]. Behaviour with strict mode off: **UNVERIFIED** on current docs (historically a cookie was issued).
- Needs a `non_identity` policy (§2). Account limit 50 tokens [LIMITS] ⇒ per-device tokens do not scale; one token per developer caps at 50.

## 5. Access in front of a Worker custom domain

[WORKERS]: Access can protect all Workers, one Worker (destination `type: "worker"`, covers routes, Custom Domains, workers.dev and previews), or a hostname/path (hostname app covers only that URL). Precedence: hostname/path > Worker-level > account-level. Worker reads identity via `ctx.access.getIdentity()` (undefined if Access did not authenticate; not passed through service bindings/RPC or Static Assets routing). **WebSockets unsupported for Worker-level Access (403)** — use a hostname-based app.
JWT validation [JWT]: validate the `Cf-Access-Jwt-Assertion` header (cookie not guaranteed); JWKS at `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, match `kid` in `public_certs`; check `iss` = team domain and `aud` = app AUD tag; keys rotate every 6 weeks with 7-day overlap. Workers example uses `jose` `createRemoteJWKSet` + `jwtVerify`. Managed OAuth requests also arrive with `Cf-Access-Jwt-Assertion` [OAUTH].

## 6. Team domain and identity providers

- Team domain: `<team>.cloudflareaccess.com` [COOKIE], [JWT]. API: `GET /accounts/{account_id}/access/organizations` → `auth_domain` ("The unique subdomain assigned to your Zero Trust organization"), `name`, `session_duration`, `user_seat_expiration_inactive_time` (min 730h), `allow_authenticate_via_warp`, `auto_redirect_to_identity`, `strict_service_token_auth`, `deny_unmatched_requests`, `warp_auth_non_browser_401`, `service_token_inactivity`, `is_ui_read_only`, … Permission: Access: Organizations, Identity Providers, and Groups Read/Write [API-ORG].
- IdPs: `GET /accounts/{account_id}/access/identity_providers` (`page`, `per_page` ≤1000) → `[{id, name, type, config, ...}]`; `type` ∈ `onetimepin, azureAD, saml, centrify, facebook, github, google-apps, google, linkedin, oidc, duo, okta, onelogin, pingone, yandex, cloudflare, passkeys` [API-IDP]. Create OTP: POST same path with `{"type":"onetimepin","config":{}}` [OTP].
- **Default IdP changed:** new orgs now get the **Cloudflare identity provider** (`type: "cloudflare"`) as default, with "Restrict to account members" on — only Cloudflare account members can sign in; if off, any Cloudflare-account holder can (subject to policies). Previously OTP was the default; "OTP is no longer added automatically" [CFIDP], [OTP], changelog 2026-06-18. Implication: a developer who isn't a member of the admin's Cloudflare account cannot log in until OTP/GitHub/Google is added or the restriction lifted.
- OTP details: sender `noreply@notify.cloudflare.com`; PIN valid 10 min, single use; email only sent if a policy allows the user [OTP].

## 7. Zero Trust Free plan

- 50 users, $0 "forever", "Teams under 50 users or enterprise proof-of-concept tests"; ZTNA included; no general app cap listed [PLANS]. Pay-as-you-go ~$7/user/month per third-party sources (**UNVERIFIED** officially).
- **Payment method required even for Free:** "If you chose the Zero Trust Free plan, this step is still needed but you will not be charged." [SETUP]
- Seat = any user with an Access authentication event (or a device connecting via Gateway/WARP); one seat per user regardless of app count; seats persist until removed unless seat expiration is enabled (1 month–1 year inactivity, checked daily); when seats run out "additional users who attempt to log in are blocked"; revoking sessions does not free a seat; user records can't be deleted [SEATS].
- Whether service-token authentications consume seats: **UNVERIFIED** (not stated; service tokens have no user identity).
- App/policy limits are the account limits in §2 (500 apps, 500 reusable policies, 50 service tokens), not plan-specific on [LIMITS]; Application Library custom apps: 50 on Free [LIMITS].
