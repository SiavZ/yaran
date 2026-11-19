# 03: Cloudflare Access JWT validation and native-app authentication

Researched 2026-11-14. cloudflared source pinned to commit `b0297f0b24c60a4cef743b7b878e2da3798cb839` (master on that date); file links below use that SHA.

Short names for the sources used throughout:

- **[VAL]** https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ (last updated Nov 2, 2026)
- **[TOK]** https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ (Jun 25, 2026)
- **[COOKIE]** https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/ (Nov 2, 2026)
- **[SESS]** https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- **[WKR]** https://developers.cloudflare.com/workers/configuration/cloudflare-access/ (Nov 2, 2026)
- **[OAUTH]** https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ (Nov 3, 2026)
- **[OAUTH-CL]** https://developers.cloudflare.com/changelog/post/2026-03-20-managed-oauth/
- **[AGENTS]** https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/
- **[SVC]** https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ (Nov 11, 2026)
- **[CLI]** https://developers.cloudflare.com/cloudflare-one/tutorials/cli/
- **[CFD-AUTH]** https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/
- **[WARP-SESS]** https://developers.cloudflare.com/cloudflare-one/team-and-resources/devices/cloudflare-one-client/configure/client-sessions/ (Nov 10, 2026)
- **[transfer.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/token/transfer.go
- **[token.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/token/token.go
- **[jwks.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/token/jwks.go
- **[encrypt.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/token/encrypt.go
- **[carrier.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/carrier/carrier.go
- **[websocket.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/carrier/websocket.go
- **[cmd.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/cmd/cloudflared/access/cmd.go
- **[acc-carrier.go]** https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/cmd/cloudflared/access/carrier.go

---

## Part A: JWT validation

### 1. `Cf-Access-Jwt-Assertion` header vs `CF_Authorization` cookie

- Every authenticated request Access forwards to the origin carries the application token in the `Cf-Access-Jwt-Assertion` request header. Browser requests also carry it as the `CF_Authorization` cookie. [VAL]
- Cloudflare's advice: "We recommend validating the `Cf-Access-Jwt-Assertion` header instead of the `CF_Authorization` cookie, since the cookie is not guaranteed to be passed." [VAL]
- Native clients authenticated by service token, `cf-access-token`, or a managed OAuth bearer token send no cookie, so the header is the only signal that works for every client type. This follows from the above plus [OAUTH] ("Cloudflare ... forwards a signed assertion to your origin").
- There are two kinds of `CF_Authorization` token: the **global session token**, a cookie on `<team>.cloudflareaccess.com`, and the **application token**, a cookie on the protected hostname. [COOKIE]
- [TOK] says "Unless your application is connected to Access through Cloudflare Tunnel, your application must validate the token." In other words, Cloudflare treats validation as optional behind a Tunnel. A Worker that sits on the public edge, and is not behind the Tunnel, is not covered by that exemption and should validate.

### 2. Certs endpoint, JWKS shape, rotation, algorithm, required checks

- URL: `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs` [VAL]. cloudflared hard-codes the same path (`accessCertPath = "/cdn-cgi/access/certs"`) and accepts only auth domains ending in `.cloudflareaccess.com` (FedRAMP: `.fed.cloudflareaccess.com`). [jwks.go]
- Response shape [VAL]:
  - `keys`: current and previous keys as JWKs (`kid`, `kty: "RSA"`, `alg: "RS256"`, `use: "sig"`, `e`, `n`)
  - `public_cert`: `{kid, cert}` for the current key, in PEM
  - `public_certs`: `[{kid, cert}, ...]` for both keys, in PEM
- Rotation: "By default, Access rotates the signing key every 6 weeks ... Previous keys remain valid for 7 days after rotation." Keys can also be rotated by hand through the API (`.../access/keys/rotate`). [VAL]
- Do not hard-code keys. Do not read `public_cert`, because a cache can hold a stale copy. Match the JWT's `kid` against the key set instead. [VAL]
- Algorithm: RS256. The JWT header is `{"alg":"RS256","kid":"...","typ":"JWT"}`. [TOK] cloudflared accepts only `jose.RS256` (`signatureAlgs`). [jwks.go]
- Required checks [VAL]:
  - the signature verifies with the key whose `kid` matches
  - `iss` equals `https://<team-name>.cloudflareaccess.com`
  - `aud` contains the application's AUD tag (the tag is under Zero Trust > Access controls > Applications > Edit > Additional settings, and it "will never change unless you delete or recreate the Access application")
  - `exp` (and `nbf`) are standard JWT claims; jose's `jwtVerify` enforces them by default
- `aud` is an array in identity tokens (`"aud": ["32ea..."]`) [TOK]. cloudflared's parser accepts either a string or an array. [token.go `jwtPayload.UnmarshalJSON`]

### 3. Claims

Identity (IdP) token payload [TOK]:

```json
{ "aud": ["<AUD>"], "email": "user@example.com", "exp": 1659474457, "iat": 1659474397,
  "nbf": 1659474397, "iss": "https://yourteam.cloudflareaccess.com", "type": "app",
  "identity_nonce": "6ei69kawdKzMIAPF", "sub": "7335d417-...", "country": "US" }
```

- `type` is `app` for an application token and `org` for the global session token.
- `identity_nonce` is "a cache key used to get the user's identity".
- `sub` is unique per email per account. It changes if the user is removed and added back, or logs into a different organization.
- Custom SAML attributes and OIDC claims go into a `custom` claim on a best-effort basis. Access trims them once the serialized `custom` claim passes about 1,000 bytes, dropping values from the end of the list first; groups usually go first. Do not authorize on large custom claims; use get-identity instead. [TOK]

Service-token payload [TOK]:

```json
{ "type": "app", "aud": ["<AUD>"], "exp": 1659474457, "iss": "https://yourteam.cloudflareaccess.com",
  "common_name": "e367826f93b8d71185e03fe518aff3b4.access", "iat": 1659474397, "sub": "" }
```

- No `email` claim. `common_name` is the Client ID (`CF-Access-Client-Id`), and `sub` is the empty string. A Worker can tell the two kinds apart with `sub === ""` and `common_name` present. That rule is inferred from the two documented shapes.
- Managed OAuth: the client holds an **opaque** token (`oauth:...`). Cloudflare resolves it and forwards "a signed assertion" to the origin, so the origin sees a normal `Cf-Access-Jwt-Assertion`. [OAUTH] The exact claim set in that forwarded JWT is UNVERIFIED; it presumably matches the identity shape above.
- `ctx.access` caveat: for "a non-browser client over WARP, `ctx.access` only populates the `aud` field", while the `Cf-Access-Jwt-Assertion` header "remains complete". [WKR]

### 4. Validation code for Workers

**Option 1: `ctx.access` (no JWT parsing).** This applies when Access protects the Worker's own hostname and the Worker is invoked directly. [WKR] [VAL]

```js
export default {
  async fetch(request, env, ctx) {
    if (!ctx.access) return new Response("Access required", { status: 403 });
    const identity = await ctx.access.getIdentity();
    return new Response(`Hello, ${identity?.email ?? "unknown"}`);
  },
};
```

Limitations [WKR]:

- `ctx.access` is not propagated through Service Bindings or RPC.
- It is not passed to the user Worker when the Worker uses **Static Assets**, which includes Vite-plugin builds that add `assets` implicitly.
- Over WARP from non-browser clients it carries only `aud`.
- **Worker-level Access policies do not support WebSockets**: "WebSocket upgrade requests to a Worker protected by a worker-level Access policy will fail with a `403` error." Protect a WebSocket-serving Worker with a hostname-based self-hosted application instead.
- Local dev: `wrangler.jsonc` `"access": {"dev": {"aud": "...", "identity": {...}}}` simulates an identity.

**Option 2: jose (the official sample, verbatim core)** [VAL]:

```js
import { jwtVerify, createRemoteJWKSet } from "jose";
// ...
const token = request.headers.get("cf-access-jwt-assertion");
if (!token) return new Response("Missing required CF Access JWT", { status: 403 });
const JWKS = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
const { payload } = await jwtVerify(token, JWKS, {
  issuer: env.TEAM_DOMAIN,      // "https://<team>.cloudflareaccess.com"
  audience: env.POLICY_AUD,     // AUD tag
});
```

Hardening beyond the sample (my recommendations; the jose behaviour cited is from https://github.com/panva/jose/blob/main/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md):

- Create `JWKS` at **module scope**, not inside `fetch`. jose caches keys for `cacheMaxAge` (default 10 minutes), and an unknown `kid` triggers a refetch only after `cooldownDuration` (default 30 s). The sample builds the set per request, which throws that cache away and fetches certs on every request.
- Pass `algorithms: ["RS256"]` to pin the algorithm, which matches cloudflared's `signatureAlgs`.
- Make the comparison exact: `TEAM_DOMAIN` must include `https://` and have no trailing slash, to match `iss`.

### 5. `/cdn-cgi/access/get-identity`

- Call it as `curl -H 'cookie: CF_Authorization=<user-token>' https://<team-name>.cloudflareaccess.com/cdn-cgi/access/get-identity`. [TOK]
- It returns JSON with these fields: `email`, `idp`, `geo`, `user_uuid`, `devicePosture`, `account_id`, `iat`, `ip`, `auth_status` (mTLS), `common_name` (mTLS cert CN), `service_token_id`, `service_token_status`, `is_warp`, `is_gateway`, `gateway_account_id`, `device_id`, `version`, `device_sessions`. [TOK]
- Use it for the full group list when the JWT's `custom` claim was trimmed. [TOK] `ctx.access.getIdentity()` is the Worker-native equivalent. [WKR]
- UNVERIFIED: whether the same path also works on the application hostname (`https://<app-host>/cdn-cgi/access/get-identity`) with the application token. The docs show only the team domain.
- `https://<team>.cloudflareaccess.com/cdn-cgi/access/refresh-identity` re-authenticates the user, resets the session duration and refreshes groups (browser flow). [WARP-SESS]

---

## Part B: Native apps

### 6. How `cloudflared access login <url>` gets a token (from source)

**Step 0: discover the app.** cloudflared sends `HEAD <url>` with `cf-access-metadata-request: true` and does not follow redirects. The edge answers with a `cf-access-metadata` response header: an RS256 JWT with claims `{type:"match", hostname, auth_domain, aud, app_hostname, iat}`. cloudflared then:

- verifies it against `https://<auth_domain>/cdn-cgi/access/certs`
- requires `hostname` to equal the requested host, `type == "match"`, and a non-empty `aud`
- requires `iat` to be no older than 24 h and no more than 5 min in the future [token.go `GetAppInfo`/`fetchMetadataJWT`, jwks.go]

**Step 1: use a cached token.** It looks for the app token at `~/.cloudflared/<host>-<aud>-token` and discards it if `exp` has passed or `aud` does not match. [token.go `GetAppTokenIfExists`, path.go] File locks (`.lock`, `.url`) coordinate concurrent processes.

**Step 2: exchange the org token** (`exchangeOrgToken`). This runs if a cached org (global) token exists. [token.go]

- cloudflared sends `HEAD <appURL>` and follows redirects with this hook:
  - on a redirect to `/cdn-cgi/access/login`, attach cookie `CF_Authorization=<orgToken>`
  - on a redirect to `/cdn-cgi/access/authorized`, attach the `CF_AppSession` cookie captured from an earlier response
  - stop after `/authorized`
- The app token is the `CF_Authorization` value in the final `Set-Cookie`, if it has not expired. This is plain Access SSO done with the org token as a cookie.

**Step 3: the transfer ("loginhelper") flow** (`getTokensFromEdge` → `RunTransfer`). [transfer.go, encrypt.go]

1. Generate an **ephemeral NaCl box (Curve25519/XSalsa20/Poly1305) keypair**. The base64url public key is "the sole capability identifier for retrieving credentials from the transfer service". [encrypt.go]
2. Build the browser URL (`buildRequestURL`, `cli=true` path):
   - start from the app URL (`FetchToken` uses the host only, so the path is cleared; `FetchTokenWithRedirect`, which is what `login` uses, keeps the full URL)
   - add query `token=<pubkey>` and `aud=<AUD>`, and set `redirect_url=<that URL, with token & aud>`
   - add `send_org_token=true` ("the cli endpoint should return both the org and app token")
   - add `edge_token_transfer=true` ("use new LoginHelper service built on workers")
   - add `close_interstitial=true` if `--auto-close` was given
   - set the path to `cdn-cgi/access/cli`

   The result looks like:
   ```
   https://<app-host>/cdn-cgi/access/cli?aud=<AUD>&token=<pubkey>&redirect_url=https%3A%2F%2F<app-host>%2F...%3Faud%3D...%26token%3D...&send_org_token=true&edge_token_transfer=true[&close_interstitial=true]
   ```
3. Open it in the system browser. If that fails, print it to stderr.
4. Long-poll `GET https://login.cloudflareaccess.org/transfer/<pubkey>` (FedRAMP: `https://login.fed.cloudflareaccess.org/`) with `User-Agent: cloudflared/<ver>`:
   - 60 s client timeout per request, at most 10 attempts
   - a status of 500 or above is an error
   - any other non-200 means "Waiting for login..." and the client polls again
   - 200 means the body is base64 ciphertext (24-byte nonce prefix) and the sender's public key is in the `service-public-key` response header
5. Decrypt with `box.Open` to get JSON `{"app_token": "...", "org_token": "..."}` (`transferServiceResponse`). Write both to disk with mode 0600. [token.go]

**Step 4: verify.** `verifyTokenAtEdge`/`isTokenValid` sends the token to the origin with `?cloudflared_token_check=true` and no redirect following. A 302 to `/cdn-cgi/access/login` (`IsAccessResponse`) means the token is invalid. [cmd.go, carrier.go]

**Output:**

- `login` prints `Successfully fetched your token:\n\n<jwt>` by default
- `--no-verbose` (or `--app`) prints only the JWT
- `-q` prints nothing [cmd.go]
- `cloudflared access token -app=<url>` prints the cached token [CLI]

Docs vs source discrepancies:

- [CLI] says the curl wrapper injects the token "as a query argument named token". The source injects a header (`cmdArgs = append(cmdArgs, fmt.Sprintf("%s: %s", carrier.CFAccessTokenHeader, tok))`), and the command's own help says "injects the JWT into a cf-access-token header". [cmd.go] The source is authoritative.
- [AGENTS] uses `CF_TOKEN=$(cloudflared access login https://example.com)`. Without `--no-verbose`, that captures the chatty banner too. [cmd.go]

### 7. How the token is sent, and how long it lasts

- **Header `cf-access-token: <app JWT>`**, confirmed:
  - `CFAccessTokenHeader = "Cf-Access-Token"` [carrier.go]
  - `curl -H "cf-access-token: $TOKEN" https://example.com/...` [CLI]
  - the same pattern in [AGENTS]
  - [OAUTH] also names it as the way to forward an Access JWT downstream ("forwards it to downstream apps as `Cf-Access-Token`")
- **WebSockets:** cloudflared's own WebSocket client sends the same header on the upgrade request. On a 302 to `/cdn-cgi/access/login` it fetches a token and redials with `Cf-Access-Token`. [websocket.go `createWebsocketStream` → `createAccessAuthenticatedStream` → `BuildAccessRequest`] This shows that a header-authenticated WS upgrade through Access works. Native WS clients (OkHttp, URLSessionWebSocketTask) can set custom upgrade headers; browsers cannot.
- **Cookie `CF_Authorization=<app JWT>`** also works, because it is how Access normally checks requests. [COOKIE] [WKR] (a "valid `CF_Authorization` cookie" on a `fetch()` subrequest is accepted). Avoid it if the app has **Binding Cookie** on, since a bare `CF_Authorization` is then rejected without `CF_Binding`. Cloudflare says not to use Binding Cookie or HttpOnly for non-browser tools. [COOKIE]
- **Lifetime:**
  - The app token lasts for the **policy session duration**, which defaults to the **application session duration** (default 24 h, range "immediate timeout to one month"). [SESS] [COOKIE]
  - The org/global token lasts for the **global session duration** (15 min to 1 month, default 24 h). [SESS]
  - When an app token expires, Access re-issues one silently if the global token is still valid. [SESS] cloudflared does the same thing in its org-token exchange (step 2 above).
  - If **Authenticate with Cloudflare One Client** is on, the client session duration (up to 90 days) overrides all of the above. [SESS] [WARP-SESS]

### 8. Is there an official flow for third-party native/mobile apps?

**Yes, as of 2026-03-20: Managed OAuth.** [OAUTH] [OAUTH-CL] [AGENTS]

What it is:

- Access acts as a standard OAuth 2.0 authorization server for a self-hosted app. It is opt-in per app: Advanced settings > Managed OAuth, or API `oauth_configuration.enabled: true`.
- Prerequisite: "An OAuth client that supports RFC 8707" (the `resource` parameter). [OAUTH]
- The changelog positions it as the replacement for "the established workaround ... `cloudflared access curl`". [OAUTH-CL]

**Native redirect URIs are documented explicitly:** "Native applications may use private-use URI schemes such as `cursor://anysphere.cursor-mcp/oauth/callback` or `com.example.app:/oauth/callback`. Custom-scheme URIs must be listed explicitly and match exactly; they cannot contain wildcards, credentials, or fragments." [OAUTH] The other options are `allow_any_on_localhost` and `allow_any_on_loopback`.

Discovery:

- Non-browser requests get `401` + `www-authenticate: Bearer realm="OAuth", error="invalid_token", ..., resource_metadata="https://<host>/.well-known/cloudflare-access-protected-resource/"`.
- That metadata returns `authorization_servers: ["https://<team>.cloudflareaccess.com"]`.
- AS metadata at `https://<team>.cloudflareaccess.com/.well-known/oauth-authorization-server` lists [AGENTS]:
  - `authorization_endpoint`: `.../cdn-cgi/access/oauth/authorization`
  - `token_endpoint`: `.../cdn-cgi/access/oauth/token`
  - `registration_endpoint`: `.../cdn-cgi/access/oauth/registration`
  - `revocation_endpoint`: `.../cdn-cgi/access/oauth/revoke`
  - `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported` including `"none"` (public clients)
  - grants: `authorization_code`, `refresh_token`
- Discrepancy: [OAUTH] instead says the client fetches `https://<your-app-domain>/.well-known/oauth-authorization-server`. Clients should follow the `www-authenticate` → resource metadata chain rather than hard-coding either location.

Flow [AGENTS]:

1. Dynamic client registration: POST `{redirect_uris, token_endpoint_auth_method:"none", grant_types:["authorization_code"], response_types:["code"], resource}` and receive a `client_id`. Allowed redirect URIs apply "for dynamically registered clients".
2. PKCE S256. The challenge must start with `[a-zA-Z0-9]`, because a leading `-` or `_` breaks parsing.
3. Authorize with `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, `resource=<app URL>`.
4. Exchange at the token endpoint and receive `{"access_token":"oauth:<token>","token_type":"bearer","expires_in":900,"refresh_token":"oauth:<refresh>"}`.
5. Call the app with `Authorization: Bearer <access_token>`.
6. Refresh with `grant_type=refresh_token`.

Tokens:

- Opaque, not JWTs. The edge resolves them and forwards a signed assertion to the origin, so an origin or Worker still validates `Cf-Access-Jwt-Assertion`. [OAUTH]
- Lifetimes: access token default 15 min (`grant.access_token_lifetime`); refresh grant set by `grant.session_duration`. Policies are re-evaluated on every refresh. Recommended: 5–15 min access tokens with a 1–2 week grant. [OAUTH]
- Tokens are valid across all domains of a multi-domain application. [OAUTH]
- On mobile, this maps onto the standard RFC 8252 pattern: `ASWebAuthenticationSession` (iOS) or Custom Tabs (Android) to the authorization endpoint, with a custom-scheme callback. AppAuth-style libraries fit, provided they send `resource`. The mapping is my inference; the building blocks are the documented ones above.
- Caveat: "If you run your own OAuth server behind an Access application and rely on your own `WWW-Authenticate` headers, do not enable this feature." [OAUTH]
- UNVERIFIED: whether a WebSocket upgrade with `Authorization: Bearer oauth:...` is accepted. No doc mentions WebSockets with managed OAuth. Test this before relying on it.

**Cloudflare One Client (WARP) authentication.**

- Setting: account level under Access settings > "Authenticate with Cloudflare One Client", per app `allow_authenticate_via_warp` (Access applications API). It works only with Allow/Block policies and not with Binding Cookie. Session up to 90 days. Beta. [WARP-SESS]
- With it on, the device's client session authenticates requests, and `warp_auth_non_browser_401: true` makes failures return 401 rather than 302 "for non-browser traffic". [SESS] [WKR] confirms that non-browser clients over WARP are authenticated (full `Cf-Access-Jwt-Assertion`, but `ctx.access` carries only `aud`).
- The catch: the user must install and enroll the Cloudflare One Client app on the phone. That is an MDM/enterprise posture, not a self-contained app flow.
- UNVERIFIED: that this feature works on the iOS and Android clients specifically. The docs give no per-platform matrix for it; the only matrix on the page belongs to the separate Entra silent-reauth feature, which lists iOS/Android as unsupported.

**Custom Tab / ASWebAuthenticationSession and extracting `CF_Authorization`: not feasible.**

- `ASWebAuthenticationSession` hands the app only the **callback URL** through its completion handler ("The session passes this URL back to the app through a completion handler"). There is no cookie API. [https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession] Forum reports agree there is no way to extract its cookies: https://developer.apple.com/forums/thread/801879
- Android Custom Tabs likewise run in the browser's cookie jar, and the app cannot read it. UNVERIFIED with a primary source, though it is widely known.
- Access has no redirect-to-app hook that would deliver the token in a callback URL, apart from managed OAuth.
- An embedded `WKWebView`/`android.webkit.WebView` can read the cookie natively (`WKHTTPCookieStore`, `CookieManager`). But Google blocks OAuth in embedded webviews (`disallowed_useragent`, enforced since 2021–2023): https://developers.googleblog.com/en/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/ This breaks any Access IdP that is Google, and RFC 8252 discourages it. It also requires HttpOnly to be readable, which native cookie stores do allow (UNVERIFIED).

**Re-implementing the cloudflared transfer flow in a mobile app: technically possible, unsupported.**

- Everything in section 6 is plain HTTPS plus NaCl box: open a Custom Tab or ASWebAuthenticationSession to `/cdn-cgi/access/cli?...`, poll `login.cloudflareaccess.org/transfer/<pubkey>`, decrypt.
- It is an undocumented internal protocol with no public spec or stability promise. The only docs describe it as "a cryptographic transfer". [CLI]
- Cloudflare says automated services should prefer service tokens over cloudflared authentication. [CFD-AUTH] It now steers non-browser clients to managed OAuth. [OAUTH-CL]
- Feasibility from a phone is my inference from the source and has not been tested.

### 9. Service tokens as the machine/mobile fallback

- Headers: `CF-Access-Client-Id: <id>` and `CF-Access-Client-Secret: <secret>`. [SVC] cloudflared uses `Cf-Access-Client-Id` / `Cf-Access-Client-Secret`. [acc-carrier.go]
- Single-header option: set app `read_service_tokens_from_header: "Authorization"` and send `Authorization: {"cf-access-client-id": "...", "cf-access-client-secret": "..."}`. [SVC]
- The policy action must be **Service Auth** (API `decision: "non_identity"`), "otherwise, Access will prompt for an identity provider login". [SVC]
- Tag-based authorization (`service_token_tag`, up to 5 tags per token) is available. [SVC]
- The JWT the origin sees has no email, `common_name` = Client ID and `sub` = `""`. [TOK]

Strict service token authentication [SVC]:

- On by default and cannot be turned off for orgs created on or after **2026-10-05**; existing orgs can opt in via `strict_service_token_auth: true`.
- Failures return 401/403 instead of a 302.
- Only Service Auth policies count, and any `CF_Authorization` cookie is ignored.
- **No `CF_Authorization` cookie is returned**, so the client must send the headers on every request.

Lifecycle [SVC]:

- Duration is chosen at creation (e.g. `8760h`) and can be refreshed or extended.
- Rotation keeps the Client ID, with a grace period of 1 h to 30 days.
- Since 2026-08-26 new secrets look like `cfast_<40 alnum><8 checksum>`, so secret scanners (e.g. GitHub) report leaks. A reported token is disabled until it is rotated.
- Inactive tokens can be disabled or deleted automatically after 30–365 days.
- The secret is shown only once.

Security tradeoffs (assessment; the facts are cited above):

- **No user identity.** Access cannot apply per-user or per-group policy and the origin cannot attribute actions to a user. [OAUTH comparison table]
- **A static, long-lived bearer secret on a device.** It can be extracted from an app binary or a rooted or jailbroken device. Everyone holding the same token is indistinguishable unless each install or user gets its own token, which then needs a provisioning channel. The Keychain/Keystore lowers the risk but does not remove it.
- **Revocation is per token.** Revoking one shared token cuts off every device that uses it.
- **No re-auth cadence or MFA.** Validity is the token duration, not a session duration.
- Cloudflare positions service tokens for "fully automated systems, cron jobs, CI/CD pipelines, server-to-server" and managed OAuth for "interactive CLI tools, AI agents, SDKs where a human initiates the request". [OAUTH] By that line, a human-driven mobile app belongs on managed OAuth.
- The [CFD-AUTH] note recommends Service Auth or WARP-to-Tunnel for automated services, because cloudflared's WebSocket-based connections "may close unexpectedly".

---

## Summary of UNVERIFIED items

1. Whether a WebSocket upgrade accepts `Authorization: Bearer oauth:...` (managed OAuth). It is documented for HTTP only.
2. The exact claim set of the `Cf-Access-Jwt-Assertion` that Access forwards for managed OAuth requests (presumably the identity shape).
3. Whether "Authenticate with Cloudflare One Client" (`allow_authenticate_via_warp`) works on the iOS and Android clients.
4. Whether `/cdn-cgi/access/get-identity` also works on the application hostname, rather than only the team domain.
5. That Android Custom Tabs cannot expose cookies (no primary source fetched), and that native webview cookie stores return HttpOnly cookies.
6. That the cloudflared transfer protocol works from a mobile client (inferred from source; untested and undocumented).
7. Where the managed OAuth AS metadata lives. [OAUTH] says the app domain `/.well-known/oauth-authorization-server`; [AGENTS] says the team domain, reached via `/.well-known/cloudflare-access-protected-resource/` on the app.
