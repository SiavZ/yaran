# R4: Cloudflare control plane for yaran, online research

Compiled 2026-11-14. The lead agent split the work across six parallel sub-agents, then cross-checked their results and merged them. Sources are mainly developers.cloudflare.com (pages mostly dated Aug to Nov 2026), the official API reference, cloudflare-typescript field names, and the cloudflared source at tag 2026.11.0, commit b0297f0b. Anything not confirmed is marked **UNVERIFIED** where it appears. None of the flows were exercised against a live account.

Contents
- Part 1: Tunnel API and DNS (topics 1, 2)
- Part 2: Access applications, policies, service tokens, plan limits (topic 3)
- Part 3: Access JWT validation and native/mobile authentication (topics 4, 5)
- Part 4: API token template URLs and the Deploy to Cloudflare button (topics 6, 7)
- Part 5: Workers platform specifics and limits (topic 8)
- Part 6: cloudflared binary, and how Cloudflare handles data in transit (topics 9, 10)
- Closing: design constraints and recommendations

Cross-check notes from the lead
- Managed OAuth for Access exists. It was announced in the 2026-03-20 changelog, and the doc page is https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/ . It is opt-in per self-hosted app, needs an OAuth client that supports RFC 8707, and the API reference still marks it beta. The lead re-confirmed it independently.
- Parts 2 and 3 agree that strict service token authentication is forced on for Zero Trust orgs created on or after 2026-10-05: no cookie, and 401/403 instead of 302. Source: https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/
- Parts 4 and 5 agree on the API rate limit of 1,200 requests per 5 minutes per user or token.
- Subrequest limits: Part 5 says the Paid plan allows 10,000 by default, configurable upward. That replaces the old figure of 1,000 and is the current doc.
- Parts 2 and 3 agree that Access applied at the Worker level (`ctx.access` / Worker Access toggle) rejects WebSocket upgrades with a 403. A hostname-based self-hosted Access app is required instead.


---

# 01: Cloudflare Tunnel API + DNS for per-machine remotely-managed tunnels

Researched 2026-11-14. Base URL for all calls: `https://api.cloudflare.com/client/v4`. Auth: `Authorization: Bearer <api_token>` (legacy X-Auth-Email/X-Auth-Key discouraged). Facts tagged with a source; anything not confirmed in a source is marked **UNVERIFIED**.

Key sources (with "last updated" where the page shows it):
- [S1] Create a tunnel (API) tutorial, updated Apr 17, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/
- [S2] API ref, create cfd_tunnel: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/create/
- [S3] API ref, get token: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/token/methods/get/
- [S4] API ref, PUT configurations: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/configurations/methods/update/
- [S5] API ref, DELETE tunnel: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/delete/
- [S6] API ref, DELETE connections: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/delete/
- [S7] API ref, GET connections: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get/
- [S8] API ref, PATCH tunnel: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/edit/
- [S9] API ref, list tunnels: https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/list/
- [S10] cloudflared API client source (official repo, master): https://github.com/cloudflare/cloudflared/blob/master/cfapi/tunnel.go
- [S11] Account limits, updated Nov 5, 2026: https://developers.cloudflare.com/cloudflare-one/account-limits/
- [S12] Tunnel permissions / token rotation, updated Jun 23, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/
- [S13] Origin parameters, updated Apr 17, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/
- [S14] Tunnel FAQ, updated Sep 16, 2026: https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/
- [S15] Tunnel DNS records, updated Apr 17, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/
- [S16] API ref, create DNS record: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/
- [S17] API token permissions list, updated Oct 30, 2026: https://developers.cloudflare.com/fundamentals/api/reference/permissions/
- [S18] API ref, create hostname route: https://developers.cloudflare.com/api/resources/zero_trust/subresources/networks/subresources/hostname_routes/methods/create/
- [S19] Connect a private hostname, updated Oct 20, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/cloudflared/connect-private-hostname/
- [S20] Tunnel changelog: https://developers.cloudflare.com/changelog/product/tunnel/ (entries: https://developers.cloudflare.com/changelog/post/2026-08-11-hostname-routing-ga-public-initial-resolved-ips/ , https://developers.cloudflare.com/changelog/post/2025-09-18-tunnel-hostname-routing/)
- [S21] Universal SSL limitations, updated Oct 9, 2026: https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/
- [S22] Wildcard DNS records, updated Apr 16, 2026: https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/
- [S23] Tunnel configuration file (local mgmt), updated Nov 10, 2026: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/
- [S24] WebSockets, updated Aug 14, 2026: https://developers.cloudflare.com/network/websockets/

---

## 1. Tunnel API (cfd_tunnel)

### 1.1 Create a remotely-managed tunnel
`POST /accounts/{account_id}/cfd_tunnel`

Request:
```json
{ "name": "yaran-<machine-id>", "config_src": "cloudflare" }
```
- `name` (string): required [S2]. No length/charset constraints documented [S2]. cloudflared's own client refuses an empty name and a name that parses as a UUID [S10]; a duplicate name returns HTTP 409 (cloudflared maps it to `ErrTunnelNameConflict`) [S10]. Whether the server itself rejects UUID-shaped names, max length, and whether a deleted tunnel's name can be reused immediately: **UNVERIFIED**.
- `config_src`: optional, `"local"` | `"cloudflare"`; `cloudflare` = remotely managed (dashboard/API config) [S2][S1].
- `tunnel_secret`: **optional**. API ref describes it as "password for a locally managed tunnel", >= 32 bytes, base64 [S2]. The official API tutorial sends only `name` + `config_src` and the server returns a generated secret in `credentials_file.TunnelSecret` [S1]. So: omit it for remote tunnels.

Response (from the tutorial's example, field names) [S1]:
```json
{
  "success": true, "errors": [], "messages": [],
  "result": {
    "id": "<uuid>", "account_tag": "...", "created_at": "...", "deleted_at": null,
    "name": "...", "connections": [], "conns_active_at": null, "conns_inactive_at": "...",
    "tun_type": "cfd_tunnel", "metadata": {}, "status": "inactive", "remote_config": true,
    "credentials_file": { "AccountTag": "...", "TunnelID": "...", "TunnelName": "...", "TunnelSecret": "..." },
    "token": "eyJhIjoi..."
  }
}
```
- Discrepancy: the API reference schema for create does NOT list `token` or `credentials_file` [S2], but the tutorial says "Copy the id and token values shown in the output" [S1], and cloudflared's client decodes create into `TunnelWithToken{Tunnel, Token string json:"token"}` [S10]. Treat `result.token` as present but fall back to the token endpoint (1.2) if absent.
- Schema fields per API ref: `id`, `account_tag`, `config_src`, `connections` (deprecated), `conns_active_at` (first connected; null = inactive), `conns_inactive_at` (lost all connections; null = active), `created_at`, `deleted_at`, `metadata`, `name`, `remote_config` (deprecated, use `config_src`), `status`, `tun_type` [S2].
- Changelog Jul 9, 2026: the `connections` field is dropped from tunnel list/get responses (removal set for Oct 5, 2026); use the connections endpoint [S20].

Permission (any one): Cloudflare One Connectors Write | Cloudflare One Connector: cloudflared Write | Cloudflare Tunnel Write [S2].

### 1.2 Get the tunnel token
`GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`
Response: `{ "success": true, "errors": [], "messages": [], "result": "eyJhIjoiNWFiNGU5Z..." }`; `result` is a string, treat as secret [S3].
Permission: **Write** (same three as create); Read is not enough [S3].
Run with: `cloudflared tunnel run --token <token>` / `cloudflared service install <token>` [S1].
A token alone runs the tunnel: "Anyone with access to the token will be able to run the tunnel" [S12].

### 1.3 Push ingress config (remote tunnel)
`PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` (replaces the whole config) [S4]

Request:
```json
{
  "config": {
    "ingress": [
      {
        "hostname": "dev-alice.example.com",
        "service": "http://localhost:3890",
        "originRequest": { "connectTimeout": 10, "access": { "required": true, "teamName": "<team>", "audTag": ["<aud>"] } }
      },
      { "service": "http_status:404" }
    ],
    "originRequest": {}
  }
}
```
- `ingress[]` fields: `hostname`, `service` (`http`, `https`, `unix`, `tcp`, `ssh`, `rdp`, `unix+tls`, `smb`, or `http_status:<code>`), `path` (optional, regex), `originRequest` (optional). Top-level `config.originRequest` applies tunnel-wide [S4]. `warp-routing` appears only in the example response, not the request schema [S4].
- Response `result`: `account_id`, `config`, `created_at`, `source` (`local`|`cloudflare`), `tunnel_id`, `version` (number, response-only) [S4].
- Catch-all: the API ref does not state it [S4]. The config-file doc: "Configuration files that contain ingress rules must always include a catch-all rule that concludes the file" [S23]; cloudflared's validation requires the last (and only the last) rule to match everything. API-side enforcement is reported by third parties only: **UNVERIFIED** (always send `{ "service": "http_status:404" }` last).
- Hostname wildcards `*.example.com` are supported in ingress; a wildcard in the middle (`test.*.example.com`) is not [S23]. First matching rule wins [S23].
- **The PUT does NOT create DNS.** Neither the API ref [S4] nor the DNS page mentions auto-creation [S15]; the API tutorial makes a separate DNS POST as step 3 [S1]. (The dashboard's "published application" flow creates the record for you, but that is a dashboard convenience; for the API it is a separate call. Dashboard behavior: **UNVERIFIED** from a primary source in this pass.)
- Permission: same three Write permissions [S4].

originRequest fields (API camelCase) with defaults [S13] (field list [S4]):
| field | default | note |
|---|---|---|
| connectTimeout | 30s | TCP connect to origin, excl. TLS |
| tlsTimeout | 10s | HTTPS origins only |
| tcpKeepAlive | 30s | |
| noHappyEyeballs | false | IPv4/IPv6 fallback; relevant if `localhost` resolves to ::1 first |
| keepAliveConnections | 100 | idle pool cap |
| keepAliveTimeout | 1m30s | |
| httpHostHeader | "" | override Host sent to origin (useful if origin has a Host allowlist) |
| originServerName / matchSNItoHost / caPool / noTLSVerify | "" / false / "" / false | TLS-origin only; irrelevant for http://localhost:3890 |
| disableChunkedEncoding | false | |
| http2Origin | false | requires https origin |
| proxyType | "" | `""` or `"socks"` |
| access | none | `{required: bool, teamName: string, audTag: string[]}`: cloudflared "validate[s] the Cloudflare Access JWT prior to proxying traffic to your origin" [S13] |

- Units: the docs show Go-duration defaults (`30s`) [S13] while the API schema types the timeouts as `number` with unstated units [S4]. Which unit the API expects (seconds, per Terraform convention): **UNVERIFIED**.
- Since the origin has no auth, `access.required=true` + an Access application on the hostname is the documented in-tunnel guard [S13]. Creating the Access app is a separate API (not covered here).

### 1.4 WebSockets
- "Yes. Cloudflare Tunnel has full support for Websockets." [S14] No ingress option is needed (none exists in [S4]/[S13]).
- Zone setting `websockets` must be on (PATCH zone setting `websockets` = `"on"`); available on all plans [S24]. Default state not stated on the page: **UNVERIFIED** (believed on by default).
- Cloudflare closes idle WebSockets after an unspecified period and may drop them when it restarts edge servers during releases; implement keepalives/reconnect [S24]. The often-quoted 100 s idle timeout: **UNVERIFIED** on that page.

### 1.5 List / get / status / connections
- `GET /accounts/{account_id}/cfd_tunnel` query: `name`, `uuid`, `is_deleted` (since Dec 1, 2025 deleted tunnels are hidden unless requested [S20]), `status`, `existed_at`, `include_prefix`, `exclude_prefix`, `was_active_at`, `was_inactive_at`, `page`, `per_page` (1-1000) [S9]. `include_prefix` lets the Worker list all `yaran-` tunnels (description absent in docs; semantics inferred from name).
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}` returns the tunnel object [S1].
- `status` enum: `inactive` (never run), `degraded` (serving but unhealthy), `healthy`, `down` (no edge connections) [S9][S2]. A healthy tunnel normally shows four connections [S1].
- Read permission (any one): Cloudflare One Connectors Read/Write | Cloudflare One Connector: cloudflared Read/Write | Cloudflare Tunnel Read/Write [S9].
- `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` → `result: [ { id, arch, config_version, features, run_at, version, conns: [ { id, client_id, client_version, colo_name, opened_at, origin_ip, uuid, is_pending_reconnect (deprecated, always false) } ] } ]`, plus `result_info` [S7].

### 1.6 Delete
- `DELETE /accounts/{account_id}/cfd_tunnel/{tunnel_id}`. API ref: "The tunnel must have no active connections." No query params documented [S5].
- `?cascade=true`: not in the API ref, but cloudflared sends it: "Cascade will delete all tunnel dependencies (connections, routes, etc.) that are linked to the deleted tunnel" [S10]. Works in cloudflared's `tunnel delete -f`; officially documented semantics **UNVERIFIED**.
- Safe documented sequence: `DELETE /cfd_tunnel/{id}/connections` (optional `?client_id=<uuid>`; omitted = "all connectors will be removed", acts "independently of its current state") [S6], then `DELETE /cfd_tunnel/{id}` [S5]. Note a still-running cloudflared with a valid token may reconnect between the two calls; rotate/invalidate first if the machine is not cooperating (see 1.8). Whether connections DELETE disconnects a live cloudflared: [S12] says it "removes existing cloudflared-to-Cloudflare connections" in the compromised-token flow.
- Deletion is irreversible; for a remote tunnel "both the tunnel and its configuration are permanently deleted" [S14].
- **DNS is not cleaned up by tunnel deletion**: no source says it is; delete the CNAME yourself (`DELETE /zones/{zone_id}/dns_records/{id}`). A stale CNAME to a stopped tunnel yields error 1016 [S15]; to a deleted tunnel: **UNVERIFIED** (expect 1016/530).

### 1.7 Limits [S11]
- cloudflared tunnels per account: **1,000**
- Active cloudflared replicas per tunnel: **25**
- Published applications per tunnel: limited by **1 MB** configuration size
- Routes (CIDR + hostname routes) per account: 50,000 (published applications are not routes [S20])
- Tunnel name length/charset limits: not documented (**UNVERIFIED**).

### 1.8 Token rotation [S12]
- `PATCH /accounts/{account_id}/cfd_tunnel/{tunnel_id}` body `{ "tunnel_secret": "<base64 of >=32 random bytes>" }` (also accepts `name`) [S8]; the response's `token` field is the new token [S12] (the PATCH API ref schema does not list `token` [S8]: same discrepancy as create).
- After refresh "the old token can no longer establish new connections"; existing connectors stay connected and serving [S12].
- To evict (compromise): refresh secret, then `DELETE /cfd_tunnel/{id}/connections`; replicas must restart with the new token [S12].
- Same three Write permissions [S8].

### 1.9 API token permissions (summary)
- Tunnel calls: account-level **Cloudflare Tunnel Edit** (dashboard label used in [S1]: "Account > Cloudflare Tunnel: Edit"); the API ref names the equivalents "Cloudflare Tunnel Write", "Cloudflare One Connector: cloudflared Write", "Cloudflare One Connectors Write". The permissions page lists both "Edit" and "Write" rows with identical descriptions [S17]. Read-only status: "Cloudflare Tunnel Read" [S9][S17].
- Token retrieval requires Write, not Read [S3].
- DNS: zone-level **DNS Edit** in the dashboard ("Zone > DNS: Edit" [S1]); API ref calls it "DNS Write" [S16][S17].
- Since May 21, 2026 permissions can be scoped to individual tunnels and list endpoints are authorization-aware [S20]: a token scoped to specific tunnels cannot create new ones (**UNVERIFIED**, inferred) so the provisioning token needs account-wide Tunnel Edit.

## 2. DNS

### 2.1 Create the CNAME
`POST /zones/{zone_id}/dns_records`
```json
{ "type": "CNAME", "name": "dev-alice.example.com", "content": "<tunnel-uuid>.cfargotunnel.com", "proxied": true, "ttl": 1, "comment": "yaran tunnel <machine-id>" }
```
- Required: `name`, `ttl`, `type`; `ttl: 1` = automatic; `content` must not equal `name`; proxied CNAMEs are always flattened; `comment`/`tags` optional [S16]. Body keys match the tutorial [S1].
- Permission: DNS Write (dashboard: DNS Edit) on the zone [S16][S1].
- FedRAMP High accounts use `<UUID>.fed-cfargotunnel.com` [S15].
- The cfargotunnel.com subdomain "only proxies traffic for DNS records in the same Cloudflare account" [S15]: the zone and the tunnel must be in the same account.

### 2.2 Proxied only
- The tutorial creates it `proxied: true` [S1]. No official page states "must be proxied" in those words.
- Empirical check (2026-11-14, `dig`): `<uuid>.cfargotunnel.com` publicly resolves only to AAAA `fd10:aec2:5dae::` (a ULA, non-routable) and no A record, so a DNS-only (grey-cloud) CNAME cannot reach the tunnel. Treat proxied=true as mandatory.
- The local-mode helper `cloudflared tunnel route dns` uses a different, zone-scoped endpoint `.../tunnels/{id}/routes` with `{type, user_hostname, overwrite_existing}` and needs `cert.pem` [S15][ https://github.com/cloudflare/cloudflared/blob/master/cfapi/hostname.go ]; not usable with an API token from a Worker; use the plain DNS records API instead.

### 2.3 "Hostname routes" API: exists, but is NOT for public publishing
- `POST /accounts/{account_id}/zerotrust/routes/hostname` body `{ "hostname", "tunnel_id", "comment" }`; also GET list, GET/PATCH/DELETE `/{hostname_route_id}`; result `{id, comment, created_at, deleted_at, hostname, tun_type, tunnel_id, tunnel_name}`; permission Cloudflare One Networks Write | Cloudflare Tunnel Write [S18].
- Purpose: private hostname routing for Cloudflare One Client (WARP)/Gateway users (requires cloudflared >= 2025.7.0, WARP client, Gateway proxy) [S19], and "public hostnames to egress through a specific tunnel" (dedicated egress IP), GA Aug 11, 2026 [S20]. Neither entry covers exposing an origin to anonymous internet visitors [S20]. **Not a replacement for ingress config + CNAME.**
- No separate "public hostname / published application" API object was found; published applications are the `config.ingress` entries of the configurations PUT [S4][S20] (counted against 1 MB config, not route limits [S11][S20]).

### 2.4 Wildcards and one tunnel per machine
- A wildcard CNAME can point at only one target, so with one tunnel per machine each machine needs its own explicit CNAME (inference). Explicit records win: "A wildcard record applies only when no exact record exists at the queried name" [S22]. Wildcard records can be proxied on all plans [S22]; `*.example.com` also matches deeper names unless a specific record exists [S22].
- Ingress `*.example.com` works inside one tunnel [S23] but does not help route different hostnames to different tunnels; that routing is decided by DNS.

### 2.5 Universal SSL depth limit
- Universal SSL covers the apex and first-level subdomains only; deeper names such as `dev.www.example.com` "are **not** covered and will not serve a valid certificate" [S21]. Fix: Advanced Certificate Manager (advanced cert, or Total TLS for "automatic certificate coverage of all proxied subdomains") [S21]. The tunnel tutorial repeats this: more than one subdomain level requires ordering an Advanced Certificate [S1].
- Practical consequence: name hosts `<machine>.example.com` (one level), not `<machine>.yaran.example.com`, unless ACM is bought.

## 3. Things UNVERIFIED (summary)
1. Server-side tunnel name rules (length, charset, UUID-shaped names, reuse after delete).
2. `token` in create/PATCH responses is shown by the tutorial/rotation doc and cloudflared source but absent from the API ref schemas.
3. API-side enforcement of the trailing catch-all rule (third-party reports only).
4. Units of numeric originRequest timeouts in the API (docs show Go durations, schema says number).
5. `cascade=true` on DELETE tunnel: only in cloudflared source, not the API ref.
6. Whether DELETE connections disconnects a live cloudflared that still holds a valid token (and whether it immediately reconnects).
7. WebSockets zone setting default state; 100 s idle timeout figure.
8. Error shown for a CNAME pointing to a deleted tunnel.
9. Whether a tunnel-scoped (granular) token can create tunnels.

---

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

---

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

---

# 04: API token template URLs and the Deploy to Cloudflare button

Researched 2026-11-14. Doc dates are the "Last updated" stamps on each page. Anything not confirmed from an official Cloudflare source is marked UNVERIFIED or UNOFFICIAL.

Sources used (official):
- S1: API token template URLs, https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/ (updated Sep 21, 2026)
- S2: API token permissions, https://developers.cloudflare.com/fundamentals/api/reference/permissions/ (updated Oct 30, 2026)
- S3: Create tokens via API, https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/ (updated Sep 28, 2026)
- S4: Account API tokens, https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/ (updated Oct 23, 2026)
- S5: Rate limits, https://developers.cloudflare.com/fundamentals/api/reference/limits/ (updated Aug 25, 2026)
- S6: Deploy to Cloudflare buttons, https://developers.cloudflare.com/workers/platform/deploy-buttons/ (updated Oct 12, 2026)
- S7: Wrangler configuration, Automatic provisioning, https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning (updated Nov 12, 2026)
- S8: Workers Custom Domains, https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ (updated Nov 12, 2026)
- S9: Workers Builds, https://developers.cloudflare.com/workers/ci-cd/builds/ (updated Oct 28, 2026)
- S10: Launch blog post "Skip the setup: deploy a Workers application in seconds" (Apr 8, 2025), https://blog.cloudflare.com/deploy-workers-applications-in-seconds/
- S11: API token templates, https://developers.cloudflare.com/fundamentals/api/reference/template/

Sources used (unofficial; label as such):
- U1: Cloudflare-Datamining dashboard permission-group dump with `label` field, https://github.com/Cloudflare-Mining/Cloudflare-Datamining/blob/main/data/account/token_permission_groups_dash.json (last changed 2024-12-29)
- U2: Cloudflare-Datamining API permission-group dump (ids and names, no labels), https://github.com/Cloudflare-Mining/Cloudflare-Datamining/blob/main/data/account/token_permission_groups.json (last changed 2026-11-13)
- U3: Datamining's token URL generator, which derives the short key by stripping `_read` / `_write` from the label, https://github.com/Cloudflare-Mining/Cloudflare-Datamining/blob/main/site/src/pages/tools/api-token-url-generator.astro
- U4: third-party READMEs using `argotunnel` in template URLs, for example https://github.com/STRRL/cloudflare-tunnel-ingress-controller (README) and https://github.com/Cyb3r-Jak3/cloudflare-utils (docs/started.md)

---

## Part A: API token template URLs

### 1. URL format

There are two forms (S1):

**User-owned token** (opens `/profile/api-tokens`):
```
https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[ENCODED_PERMISSIONS]&accountId=*&zoneId=all&name=[TOKEN_NAME]
```
- `permissionGroupKeys` is required: a URL-encoded JSON array.
- `accountId` is required: `*` means all accounts.
- `zoneId` is required: `all` means all zones.
- `name` is optional.

**Account-owned token** (service principal, not tied to a user), S1:
```
https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=[ENCODED_PERMISSIONS]&name=[TOKEN_NAME]
```
- `:account` is a placeholder. The dashboard asks the user to pick an account if they have more than one (S1).
- These URLs "do not use `accountId` or `zoneId` parameters". Resource scoping happens in the dashboard form (S1).
- So the task's guess `dash.cloudflare.com/<account>/api-tokens` is not the documented form. The documented form is `/?to=/:account/api-tokens` (S1).

**Permission JSON** (S1): `[{"key":"<key>","type":"read|edit|revoke|run|purge"}]`. Use `edit`, not `write`.

**How keys resolve, which matters for the design** (S1):
- **Account-token URLs** accept a short key OR a permission group ID (32 hex characters) as `key`. S1 calls the ID "the most reliable option, since it maps to exactly one group". When you pass an ID, `type` is ignored. Unresolvable keys produce a notice in the form, so they do not fail silently.
- **User-token URLs** accept short keys only, and "any entry that does not match is dropped silently". Permission group IDs are not supported.
- Templates only pre-fill the form. The user still finishes creating the token in the dashboard (S1).

**Recommendation from the above:** generate an **account-token template URL keyed by permission group IDs**. It is officially supported and unambiguous, and a bad entry is visible to the admin. Account tokens are also better for a durable integration: S4 says they keep working "long after the user who configured the integration may have left". Access, DNS, Tunnels, D1 and Workers are all ✅ in the account-token compatibility matrix (S4). New account tokens use the `cfat_` prefix (S4).

### 2. Permission keys, names, IDs and scopes

Human names come from S2. Short keys with official backing come from S1's reference table: `account_settings`, `workers_scripts`, `d1`, `dns`, `zone`, `access` ("Access applications"), `access_acct` ("Access organizations"), `account_api_tokens`. S1 does **not** list short keys for Tunnel or Access Service Tokens.

S2 uses "Edit" in one table and "Write" in another for the same groups. The API dump (U2) calls them "Write". `type: "edit"` in the URL selects the write group (S1).

| Need | Human name (S2) | Short key | Scope | Permission group ID (write / read) |
|---|---|---|---|---|
| Tunnels | Cloudflare Tunnel Edit / Read (formerly "Argo Tunnel") | `argotunnel`: UNOFFICIAL (U1 label `argotunnel_write`; U4 usage). Not in S1. | Account (`com.cloudflare.api.account`) | `c07321b023e944ff818fec44d8203567` / `efea2ab8357b47888938f101ae5e053f` (U1, U2) |
| DNS | DNS Edit (Write) / Read | `dns` (S1) | **Zone** (`com.cloudflare.api.account.zone`) | `4755a26eedb94da69e1066d98aa820be` (U2) / `82e64a83756745bbbb1c9c2701bf816b` (official: S1, S3) |
| Access apps and policies | Access: Apps and Policies Edit / Read | `access` (S1) | Account. A separate zone-scoped variant exists (U1 label `zone_access_*`). | account: `1e13c5124ca64b72b1969a67e8829049` / `7ea222f6d5064cfa89ea366d7c1fee89` (U2) |
| Access service tokens | Access: Service Tokens Edit / Read | `access_service_token`: UNOFFICIAL, inferred from U1 label `access_service_token_write` via U3's rule. No usage found in the wild. | Account | `a1c0fec57cf94af79479a6d827fa518c` / `91f7ce32fa614d73b7e1fc8f0e78582b` (U2) |
| Access orgs, IdPs, groups | Access: Organizations, Identity Providers, and Groups Edit / Read | `access_acct` (S1, described there as "Access organizations") | Account | `bfe0d8686a584fa680f4c53b5eb0de6d` / `26bc23f853634eb4bff59983b9064fde` (U2) |
| Account settings read | Account Settings Read | `account_settings` (S1) | Account | read `c1fde68c7bcc44588cbb6ddbc16d6480` (U2) |
| Zone read | Zone Read | `zone` (S1) | **Zone** | read `c8fed203ed3043cba015a93ad1616f1f` (official: S3) |
| Workers Scripts | Workers Scripts Edit / Read | `workers_scripts` (S1) | Account | `e086da7e2179491d91ee5f35b3ca210a` (official: S1) / `1a71c399035b4950a1bd1466bbe4f420` (U2) |
| D1 | D1 Edit / Read | `d1` (S1) | Account | `09b2857d1c31407795e75e3fed8617a1` / `192192df92ee43ac90f2aeeffce67e35` (U2) |
| Mint account tokens | Account API Tokens Edit / Read | `account_api_tokens` (S1) | Account | `5bc3f8b21c554832afc660159ab75fa4` / `eb56a6953c034b9d97dd838155666f06` (U2) |
| Mint user tokens | API Tokens Edit (Write) | n/a | User (`com.cloudflare.api.user`) | `686d18d5ac6c441c867cbf6771e58a0a` (U2) |

Notes:
- S2 also lists finer-grained Access groups that could tighten scope: "Access: Apps Edit", "Access: Policies Edit", "Access: Organizations Edit", "Access: Identity Providers Edit", "Access: Groups Edit". It also lists "Cloudflare One Connector: cloudflared Read/Edit", which is separate from "Cloudflare Tunnel".
- UNVERIFIED: which of the Tunnel, cloudflared-connector, or finer Access groups each API endpoint actually requires. Check each endpoint's "Required API token permissions" block in the API reference before freezing the list.
- Every ID marked U2 comes from an unofficial datamine. Before shipping, re-check each one against `GET /accounts/{account_id}/tokens/permission_groups`; that call needs "API Tokens Read" at account level (S1). S3 says to use `id`, because "the permission `name` is cosmetic and subject to change".
- Datamined IDs that also appear in official docs, which supports the dump's accuracy: DNS Read, Zone Read, Workers Scripts Write.

### 3. Can the Worker mint scoped tokens itself? Least privilege. Rate limit.

- **Yes, via the API, but only if it already holds a token-creating token.** S3: "To create account-owned API tokens, create a token with **Account > Account API Tokens > Edit**." The endpoint is `POST /accounts/{account_id}/tokens`: https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/create/
- **User-owned token minting** (`POST /user/tokens`) needs User > API Tokens > Edit. S3 says that permission "is not available in any other template or in the Custom Token builder" except **Create additional tokens**. S11 lists that template as "API Tokens Write | User".
  - Consequence: a user-token template URL probably cannot pre-fill `api_tokens` edit. UNVERIFIED: not tested, and inferred from S3.
- **S3 warns about this approach:** "Cloudflare highly recommends that you do not grant other permissions to the token… it can create tokens with access to any of a user's resources." S3 also recommends restricting such tokens by client IP or TTL.
  - For a Worker, IP filtering does not fit: egress IPs are Cloudflare's. UNVERIFIED as a documented statement; this is my inference.
- **Account members can only grant account tokens a subset of their own account permissions** (S4). UNVERIFIED: whether a token minted by a token is bounded by the minting token's own permissions, or by the creating member's.
- **Least-privilege recommendation** (synthesis, not a Cloudflare statement):
  - Do not give the Worker token-minting power.
  - Have the admin create one account-owned token from an ID-keyed template with only: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Access: Service Tokens Edit, Account Settings Read, plus DNS Edit and Zone Read. Narrow the zone-scoped entries to the specific zone(s) in the form.
  - Add Access: Organizations, Identity Providers, and Groups only if the Worker manages IdPs or groups. Read is likely enough to look up the team domain or IdP IDs.
  - Leave out Workers Scripts and D1 unless the Worker calls those APIs at runtime. The Deploy button itself does not need them in this token.
  - S1's own best-practices list says "Principle of least privilege" and "Regular token rotation".
- **Rate limit** (S5, updated Aug 25, 2026):
  - "Client API per user/account token: 1200/5 minutes."
  - "Client API per IP: 200/second."
  - "The global rate limit for the Cloudflare API is 1,200 requests per five minute period per user, and applies cumulatively regardless of whether the request is made via the dashboard, API key, or API token."
  - Exceeding it blocks all calls for the next five minutes with HTTP 429.
  - Headers: `Ratelimit`, `Ratelimit-Policy`, `retry-after` (sent on 429 only).
  - Other limits: 50 user tokens per user, 500 account tokens per account.
  - So 1200 per 5 minutes is current and confirmed.

---

## Part B: Deploy to Cloudflare button

### 4. Requirements and URL format (S6)

- **Markdown:**
  ```
  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<your git repo URL>)
  ```
  HTML and plain-URL forms are also documented. A Worker already on Workers Builds can get a generated snippet from the dashboard share button.
- **Subdirectory / monorepo form:** S6's own example is `https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/templates/tree/main/saas-admin-template`, so the form is `/tree/<branch>/<path>`.
  - The app must be "fully isolated within that subdirectory, including any dependencies", or the build fails.
  - The subdirectory becomes the root of the new repo.
  - Several Workers in one repo need one button each.
- **Repository:** only github.com and gitlab.com work. Self-hosted GitHub or GitLab is not supported. The repo must be public.
- **Workers only;** Pages apps are not supported.
- **Wrangler config:** Cloudflare reads the source repo's Wrangler configuration file to work out resource requirements. S7 lists the minimum keys as `name`, `main` and `compatibility_date`.

### 5. Auto-provisioned resources, secrets, binding descriptions, commands, D1 migrations

- **Provisioned by the button** (S6):
  - Storage: KV, D1, R2, Hyperdrive, Vectorize, Secrets Store secrets.
  - Compute: Durable Objects, Workers AI, Queues.
  - "During deployment, Cloudflare will provision any necessary resources and update the Wrangler configuration where applicable for newly created resources (e.g. database IDs and namespace IDs)."
  - S6 also asks the source repo to include "default values for resource names, resource IDs and any other properties for each binding".
- **Bindings without IDs** (S7, Wrangler automatic provisioning):
  - Works for KV, R2, D1, Flagship, AI Search, Agent Memory, Dispatch Namespaces and Queues.
  - "add bindings to your configuration file *without* adding resource IDs, or in the case of R2, a bucket name". Resources are created with the Worker name as a prefix.
  - When deployed from the dashboard or GitHub, "their IDs will only be accessible via the dashboard. Currently, these resource IDs will not be written back to your repository."
  - S6 and S7 differ slightly on write-back: S6 says the config is updated in the new repo during the button flow. UNVERIFIED how the two interact for an ID-less binding.
- **Variables** go in Wrangler `vars` as usual (S6).
- **Secrets** go in `.dev.vars.example` or `.env.example` in dotenv format, for example `COOKIE_SIGNING_KEY=my-secret # comment`. The deployer is prompted for them on the setup page (S6). Secrets Store secrets use `secrets_store_secrets` in the Wrangler config (S6).
- **Binding descriptions:** `package.json` → `"cloudflare": { "bindings": { "<BINDING>": { "description": "..." } } }`. Inline markdown is supported: code, bold, italics, links (S6). Good place to link the token-template URL for an `API_TOKEN` secret.
  - UNVERIFIED: a secret can be left blank at deploy and filled in later. The flow in this design (deploy first, then create the token) needs that or a placeholder value.
- **Build/deploy commands** (S6):
  - Custom `build` and `deploy` scripts in `package.json` are detected and pre-filled.
  - With no `deploy` script, the default is `npx wrangler deploy`.
  - With no `build` script, the field is left blank.
- **D1 migrations are not applied automatically.** Put them in the `deploy` script (S6):
  ```json
  "deploy": "npm run db:migrations:apply && wrangler deploy",
  "db:migrations:apply": "wrangler d1 migrations apply DB_BINDING --remote"
  ```
  Reference the **binding** name, not the database name, so renamed databases still work (S6). Because this is the deploy script, migrations re-run on every Workers Builds deploy; `migrations apply` skips migrations already applied.

### 6. What the deployer ends up with

- **A new repository in their own account, cloned rather than forked.** S6: "Cloudflare clones your source repository into the user's GitHub/GitLab account where they can continue development after deploying." The deployer can rename the repo, the Worker and the resources on the setup page, and those choices are written into the new repo (S6). S10: "Cloudflare will automatically clone and create a new repository on your account."
  - Neither official source uses the word "fork". The repo is described as created, not forked, so GitHub's "Sync fork" should not be available.
  - UNVERIFIED: no fork relationship exists. Third-party reports agree, for example the FAQ at https://sublink.works/en/guide/faq.
- **CI:** the Worker is built and deployed through Workers Builds (S6). Workers Builds deploys "on push" from the connected repository (S9). UNVERIFIED: the production branch is set to the default branch automatically.
- **Upstream updates: no automatic mechanism is documented.** UNVERIFIED as an official statement, because no Cloudflare page addresses it.
  - The practical route is manual: add the original repo as a git remote, fetch, merge, and push. The push triggers a Workers Builds deploy.
  - Plan for this in the README, for example with an "Updating" section, or a GitHub Action in the template that opens PRs from upstream.
- **Custom domain after deploy** (S8):
  - Dashboard: Workers & Pages → select the Worker → Settings → Domains & Routes → Add → Custom Domain → Add Custom Domain. Cloudflare then creates the DNS record.
  - Requirements: an active Cloudflare zone, and no existing CNAME on that hostname.
  - Wrangler: `"routes": [{ "pattern": "shop.example.com", "custom_domain": true }]`.
  - S8 also points to Cloudflare Access for requiring sign-in on a Custom Domain.

## UNVERIFIED summary

1. Short keys `argotunnel` and `access_service_token` are not in official docs (unofficial datamine and third-party usage only). Use permission group IDs in an account-token URL instead.
2. Permission group IDs other than DNS Read, Zone Read and Workers Scripts Write come from an unofficial dump updated 2026-11-13. Re-verify them through the List permission groups API.
3. Exact permissions each Tunnel or Access endpoint requires: Cloudflare Tunnel vs the cloudflared connector group, and the coarse vs fine-grained Access groups.
4. Whether a user-token template URL can carry API Tokens Edit (S3 suggests not). Whether minted tokens are bounded by the minting token's permissions.
5. Deploy-button repo has no fork link. No upstream-sync feature. Production branch defaults. Whether a secret can be skipped at deploy time.
6. How S6's "IDs written to Wrangler config" squares with S7's "IDs not written back" for dashboard/GitHub deploys.

---

# 05 — Cloudflare Workers as control plane / proxy / push sender

Research date: 2026-11-14. "Doc date" = the page's own "Last updated". Pages were read through WebFetch, which summarizes, so treat exact wording as close paraphrase unless it is quoted.

## 1. Custom domains vs routes; workers.dev and preview URLs

1.1 Custom Domains send every path of a hostname to the Worker. Cloudflare creates the DNS record and an Advanced Certificate. The Worker is treated as the origin. The hostname must match exactly (no wildcard), and you cannot use a hostname that already has a CNAME record. Source: https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ (doc date 2026-11-12)
1.2 Routes are `*` patterns over a zone, such as `example.com/api/*`. They need a proxied DNS record, and the most specific pattern wins. A route with no Worker attached excludes the paths it matches. "Routes cannot be the target of a same-zone `fetch()` call." Source: https://developers.cloudflare.com/workers/configuration/routing/routes/ (doc date 2026-10-18)
1.3 Another Worker in the same zone can `fetch()` a Custom Domain without a service binding. A route or workers.dev target needs a service binding. Source: custom-domains page (1.1).
1.4 Disabling workers.dev: set `workers_dev = false` and redeploy. If the config has `routes` and no `workers_dev` key, Wrangler infers `false`. If you disable it in the dashboard, the next Wrangler deploy turns it back on unless the config says `false`. Disabling workers.dev does NOT disable Version, Preview or Deployment URLs. Source: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/ (doc date 2026-11-06)
1.5 `preview_urls = true|false`. When the key is absent, Version/Preview URLs follow workers.dev (on when workers.dev is on, off when it is off). If you leave the key out, Wrangler keeps the existing setting. Enabled preview URLs are PUBLIC unless Access protects them. Recommendation: set both `workers_dev = false` and `preview_urls = false` explicitly. Source: https://developers.cloudflare.com/workers/configuration/previews/ (doc date 2026-09-22)
1.6 UNVERIFIED: what a client receives when it hits a disabled workers.dev hostname (status code or error page). The docs do not say.

## 2. WebSocket proxying, same-zone/Tunnel fetch, Access service tokens

2.1 Outbound WebSocket client: `const resp = await fetch(url, { headers: { Upgrade: "websocket" } }); const ws = resp.webSocket; ws.accept();`. `new WebSocket(url)` also works but is auto-accepted, so you cannot set `allowHalfOpen`. For proxying, use `accept({ allowHalfOpen: true })` so the Worker forwards the Close frame itself. Source: https://developers.cloudflare.com/workers/runtime-apis/websockets/ (doc date 2026-10-12)
2.2 UNVERIFIED (no official sentence found): passing the browser's Upgrade request through unchanged with `return fetch(request)` returns the origin's 101 and transparently proxies the socket. This is widely used, but I found no current doc that states it. The documented path is 2.1 (fetch to the origin, then pair the two sockets with a `WebSocketPair`).
2.3 Same-zone fetch to a non-Worker hostname, default behaviour (no `global_fetch_strictly_public` flag): the request goes "to the zone's origin server, ignoring any Workers mapped to the URL and also bypassing Cloudflare security settings". With the `global_fetch_strictly_public` compatibility flag, it goes back through Cloudflare's "front door" like any Internet request (and can loop back into the same Worker). Source: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ (doc date 2026-09-18, whole page)
2.4 WAF custom and managed rules on the target hostname are NOT evaluated for same-zone subrequests: "Do not rely on custom rules on the target hostname to restrict access to same-zone subrequests." Source: custom-domains page (1.1).
2.5 UNVERIFIED (important): whether a default same-zone fetch to a Tunnel-backed hostname (a CNAME to `<uuid>.cfargotunnel.com`) (a) reaches the tunnel and (b) skips Cloudflare Access. By 2.3/2.4 it plausibly skips Access, which is a security hole: any code in the Worker reaches the machine with no Access check. It may also fail outright. No doc covers Tunnel targets. Community report of same-zone subrequests intermittently misrouting: https://community.cloudflare.com/t/same-zone-worker-subrequests-intermittently-routing-into-zone-instead-of-origin/896694. Must be tested on a deployed Worker. Safer options: put the Tunnel hostnames in a DIFFERENT zone from the Worker, or enable `global_fetch_strictly_public` so Access applies, or use Workers VPC (2.7).
2.6 Access service tokens from a Worker: Cloudflare's own example builds a new Request with `cf-access-client-id` / `cf-access-client-secret` headers taken from Worker secrets, and the Access app needs a "Service Auth" policy. Source: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/ (doc date not captured). The headers work only when the request actually passes through Access (see 2.5).
2.7 Workers VPC (BETA, free on all plans during beta) reaches services behind a Cloudflare Tunnel through a `vpc_services` binding (`binding`, `service_id`, `remote: true`) with `fetch()`, and needs no public hostname. WebSocket support is not stated (UNVERIFIED). Source: https://developers.cloudflare.com/workers-vpc/ (doc date 2026-10-29)

## 3. Workers limits (Free / Paid)
Source for all of section 3 unless noted: https://developers.cloudflare.com/workers/platform/limits/ (doc date 2026-11-13)

3.1 CPU time per HTTP request: Free 10 ms. Paid 30 s default, configurable up to 5 min.
3.2 CPU time per Cron run: Free 10 ms. Paid 30 s for schedules more often than hourly, 15 min for schedules of 1 hour or longer.
3.3 Subrequests per invocation: Free 50. Paid 10,000 by default, configurable through `limits` in Wrangler up to 10M. (This replaces the old 1,000 figure.) Subrequests to Cloudflare internal services: Free 1,000, Paid same as the configured limit.
3.4 Simultaneous open connections per request: 6 on both plans. Outbound WebSockets and TCP sockets count toward it.
3.5 Memory: 128 MB per isolate on both plans.
3.6 Wall-clock duration: no hard limit for HTTP requests "as long as the client remains connected". Cron, DO alarm and Queue consumer: 15 min. `ctx.waitUntil()` gives up to 30 s after the response is sent or the client disconnects.
3.7 Runtime updates: existing requests and connections, "including streaming HTTP responses and WebSocket connections", get up to 20 minutes to finish and are then dropped. Clients must reconnect. WebSocket page (2.1) confirms the disconnect.
3.8 Request body size depends on the ZONE's plan: Free 100 MB, Pro 100 MB, Business 200 MB, Enterprise up to 5 GB. Cloudflare enforces no response size limit.
3.9 WebSocket message size received by a Worker: 32 MiB. Larger messages close the socket with code 1009. Source: websockets page (2.1). No documented maximum connection duration or idle timeout apart from 3.7.
3.10 Free plan: 100,000 requests/day, reset at 00:00 UTC. Workers per account: 100 Free / 500 Paid. Env vars per Worker: 64 / 128, 5 KB each. Worker size: 64 MiB.

## 4. Durable Objects
4.1 SQLite-backed DOs are available on Free AND Paid. KV-backed DOs are not available on Free. Source: https://developers.cloudflare.com/durable-objects/platform/limits/ (doc date 2026-11-13)
4.2 Limits: unlimited objects. 100 classes (Free) / 500 (Paid). Storage per account 5 GB Free / unlimited Paid. 10 GB per DO in the table, BUT the same page's FAQ says 1 GB per DO on Free (internal discrepancy, so treat Free as 1 GB). WebSocket received message 32 MiB. CPU 30 s per request or WebSocket message, configurable up to 5 min with `limits.cpu_ms`. 6 outgoing connections. Source: 4.1 page.
4.3 Free daily quotas: 100,000 requests, 13,000 GB-s duration, 5M SQLite rows read, 100k rows written, 5 GB stored. Reset 00:00 UTC. Incoming WebSocket messages are billed 20:1 (20 messages = 1 request). Source: https://developers.cloudflare.com/durable-objects/platform/pricing/ (doc date 2026-11-13)
4.4 Hibernation API: `ctx.acceptWebSocket(ws)` plus the `webSocketMessage` and `webSocketClose` handlers. The runtime answers pings automatically. Per-socket state goes in `serializeAttachment` (max 16,384 bytes). No GB-s duration is billed while hibernated. Hibernation works ONLY when the DO is the WebSocket SERVER. An outbound WebSocket (for example the DO dialling a tunnel origin) does not hibernate and keeps the DO in memory for up to 15 min. Source: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (doc date 2026-10-30). UNVERIFIED: the maximum number of hibernatable sockets per DO (often quoted as 32,768). Not found on current pages.
4.5 Alarms: one alarm per DO at a time, and `setAlarm` replaces the existing one. Delivery is at least once. If `alarm()` throws, it is retried with exponential backoff (starting at 2 s, up to 6 retries) and then stops until you call `setAlarm` again. Wall time 15 min (3.6). Source: https://developers.cloudflare.com/durable-objects/api/alarms/ (doc date 2026-04-21)

## 5. Cron Triggers
5.1 Per account: 5 on Free, 250 on Paid. Source: limits page (3).
5.2 Minimum interval is 1 minute (minute field 0-59, finest example `* * * * *`). The docs give no explicit minimum, so this is inferred from the syntax. Schedules run in UTC. Extensions: `L`, `W`, `#`. A Worker can have several crons. Changes can take up to 15 min to propagate, and runs may be missed until then. Source: https://developers.cloudflare.com/workers/configuration/cron-triggers/ (doc date 2026-11-12)
5.3 For per-entity schedules, DO alarms (4.5) avoid the 5-cron cap on Free.

## 6. D1
6.1 Free: 10 databases, 500 MB per database, 5 GB per account, 50 queries per invocation. Paid: 10 GB per database (hard maximum), 1 TB per account, 1,000 queries per invocation. Source: https://developers.cloudflare.com/d1/platform/limits/ (doc date 2026-10-30)
6.2 Free daily: 5M rows read, 100k rows written. Once the limit is exceeded, queries return errors until 00:00 UTC. Paid includes 25B rows read and 50M rows written per month. Source: https://developers.cloudflare.com/d1/platform/pricing/ (doc date 2026-10-30)

## 7. Secrets and rate limiting
7.1 Worker secrets (`wrangler secret put`) are per Worker. Secrets Store holds account-level secrets and is still OPEN BETA: "Available in open beta". Source: https://developers.cloudflare.com/secrets-store/ (doc date 2026-08-14). I found no GA announcement as of 2026-11-14.
7.2 Secrets Store binding: `secrets_store_secrets = [{ binding, store_id, secret_name }]`. Read it with `await env.BINDING.get()`, which is async. Production secrets are not visible in local dev. Source: https://developers.cloudflare.com/secrets-store/integrations/workers/ (doc date 2026-10-12)
7.3 Secrets Store limits: 1 store per account, 100 secrets per account, 64 KiB per secret. Source: https://developers.cloudflare.com/secrets-store/manage-secrets/ (doc date 2026-10-22). UNVERIFIED: which plans include it.
7.4 Rate Limiting binding went GA on 2025-09-19. The config key is `ratelimits` (Wrangler ≥4.36.0), and the old `unsafe` binding still works. Sources: https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/ ; https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ (doc date 2026-11-12)
7.5 Semantics: `{ name, namespace_id: "<int string>", simple: { limit, period: 10|60 } }`, called as `await env.RL.limit({ key, delta? })` → `{ success }`. Counts are kept PER CLOUDFLARE LOCATION, are eventually consistent and "permissive" (callers can exceed the limit), and a denied call does not increase the count. Bindings that share a `namespace_id` share counters. Use a DO for a strict limit. `delta` (weighted requests) was added 2026-11-04 (https://developers.cloudflare.com/changelog/post/2026-11-04-rate-limit-weighted-requests/). UNVERIFIED: pricing and plan availability (not stated).

## 8. HTTP/2 outbound; APNs; FCM
8.1 APNs requires HTTP/2: "Use HTTP/2 and TLS 1.2 or later to establish a connection between your provider server and" `https://api.push.apple.com:443` / `https://api.sandbox.push.apple.com:443`. Port 2197 is an alternative. Source: https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns (read via its JSON data endpoint; no doc date)
8.2 Cloudflare's docs never say which HTTP version Workers `fetch()` uses to reach origins. Source: https://developers.cloudflare.com/workers/runtime-apis/fetch/ (doc date 2026-07-05)
8.3 Kenton Varda (workerd lead, Cloudflare), 2025-08-20: "`workerd` doesn't have HTTP/2 support, but in production it sends requests through Cloudflare's proxy stack, which (apparently) upgrades to HTTP/2 before talking to the origin." There are no active plans to add HTTP/2 to workerd. Result: APNs over plain `fetch()` works when DEPLOYED and fails in local `wrangler dev` ("Network connection lost"). His suggested local workaround is an nginx proxy that upgrades to HTTP/2. Issue is still open. Source: https://github.com/cloudflare/workerd/issues/4841
8.4 Community libraries send to APNs from Workers with JWT auth, e.g. https://github.com/FiveSheepCo/cloudflare-apns2 ("Cloudflare workers friendly client ... HTTP/2 protocol with JSON web tokens"). Use token (.p8, ES256) auth. A recent community report says mTLS (certificate auth) from a Worker to APNs returns HTTP 500: https://community.cloudflare.com/t/cloudflare-workers-outbound-mtls-to-apple-apns-consistently-returns-http-500/980002. The page returned 403 to me, so details are UNVERIFIED (seen only in a search snippet).
8.5 The `connect()` TCP sockets API offers TLS (`secureTransport: on|starttls`) but documents no ALPN option, so a self-built HTTP/2 client over raw sockets cannot negotiate `h2` (UNVERIFIED whether ALPN is settable; the docs are silent). Sockets also block Cloudflare IPs, private IPs and port 25. Source: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ (doc date 2026-10-13). Fallback if fetch→APNs ever breaks: a small relay outside Workers (UNVERIFIED need).
8.6 Web Crypto in Workers supports sign/importKey for RSASSA-PKCS1-v1_5 (RS256, used for the Google JWT) and ECDSA (ES256, used for the APNs JWT). The page does not explicitly name the pkcs8 format or the P-256 curve (both standard; UNVERIFIED on this page). Source: https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (doc date 2026-09-30)
8.7 FCM HTTP v1: `POST https://fcm.googleapis.com/v1/projects/PROJECT_ID/messages:send` with `Authorization: Bearer <OAuth2 token>` and scope `https://www.googleapis.com/auth/firebase.messaging`. No HTTP version requirement, and the example uses HTTP/1.1. Source: https://firebase.google.com/docs/cloud-messaging/send/v1-api
8.8 Getting a token from a service account: sign an RS256 JWT `{iss: client_email, scope, aud: "https://oauth2.googleapis.com/token", iat, exp ≤ iat+3600}` and POST it form-encoded to `https://oauth2.googleapis.com/token` with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`. The response carries `access_token` and `expires_in` (3600), and the token should be cached for that time. Google also allows a self-signed JWT as the bearer for some APIs. UNVERIFIED whether FCM accepts that. Source: https://developers.google.com/identity/protocols/oauth2/service-account
8.9 APNs JWT rules (refresh no more than once per 20 min, rejected after 1 h) were NOT read from Apple's page here. They are UNVERIFIED in this pass (general knowledge).

## 9. Cloudflare API rate limits
9.1 Confirmed: 1,200 requests per 5 minutes per user / account token, a cumulative global cap per user across dashboard, API key and token. Also 200 req/s per IP. GraphQL allows at most 320 per 5 min. Exceeding the limit blocks ALL calls for 5 minutes with HTTP 429 and `retry-after`. `Ratelimit` / `Ratelimit-Policy` headers are returned. Enterprise can ask for more. Source: https://developers.cloudflare.com/fundamentals/api/reference/limits/ (doc date 2026-08-25)

## Key design implications
- Free 10 ms CPU and 50 subrequests are tight for a proxy plus control plane. Paid (30 s CPU, 10k subrequests) is the realistic target. Proxying a WebSocket costs little CPU because idle socket time is not CPU time.
- Each request is capped at 6 simultaneous outbound connections, and a proxied WebSocket holds one for its whole life.
- WebSockets through a plain Worker drop on runtime updates (up to 20 min grace), so the client must reconnect.
- Biggest unknown: whether a same-zone fetch to a Tunnel hostname works and whether it skips Access (2.5). Test it, or keep tunnels in a separate zone or use Workers VPC.
- APNs: plain fetch works only when deployed (Cloudflare's edge upgrades to h2). It cannot be tested locally, and it is not a documented guarantee.

---

# 06: cloudflared as a supervised child, and what Cloudflare sees of the traffic

Researched 2026-11-14. Source code was read from a shallow clone of tag `2026.11.0`
(commit b0297f0b24c60a4cef743b7b878e2da3798cb839). Code links below use the
`SRC` prefix, which stands for `https://github.com/cloudflare/cloudflared/blob/2026.11.0/`.
Line numbers refer to that tag.

## Part A: cloudflared

### 1. License, versioning, cadence, support window

1.1 **License: Apache-2.0.** The GitHub API reports `spdx_id: Apache-2.0`, and so does the Homebrew formula.
    https://github.com/cloudflare/cloudflared/blob/2026.11.0/LICENSE ,
    https://formulae.brew.sh/api/formula/cloudflared.json

1.2 **Versioning: calendar `YYYY.M.N`, git tags carry no `v` prefix** (recent tags: `2026.11.0`, `2026.10.7`, `2026.10.6`, ...). N counts patch releases within the month. The month number has no zero padding (`2026.7.3`).
    `gh api repos/cloudflare/cloudflared/tags`, SRC`RELEASE_NOTES`

1.3 **Latest release: `2026.11.0`, published 2026-11-12T12:23:45Z.** It contains a security fix, "VULN-170057: Don't bypass access with matrix parameters", and moves the build to Go 1.27.4.
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0 , SRC`RELEASE_NOTES` lines 1-5

1.4 **Cadence: frequent and irregular.** There were 31 releases in calendar 2026 so far (2026.1.0 through 2026.11.0; there is no 2026.4.x), 18 in 2025, and 30 GitHub releases in the 12 months to 2026-11-14. October 2026 alone had eight (2026.10.0 to 2026.10.7). Several of them are security fixes (`VULN-*` entries).
    SRC`RELEASE_NOTES` ; `gh api repos/cloudflare/cloudflared/releases`

1.5 **Support policy: one year.** Docs: "Cloudflare supports versions of `cloudflared` that are within one year of the most recent release." The README adds: "Breaking changes unrelated to feature availability may be introduced that will impact versions released more than one year ago."
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ ,
    SRC`README.md` (section "Deprecated versions")

1.6 **Breaking-change policy for the CLI.** The README says: "Removal of CLI flags, environment variables, configuration keys, or commands is a breaking change. Such removals must be announced in the Cloudflare Tunnel changelog before the release that removes them." That gives a supervisor that passes flags some protection.
    SRC`README.md` (section "Breaking Changes"), https://developers.cloudflare.com/changelog/product/tunnel/

### 2. Binaries, checksums, signatures, packages

2.1 **Release assets for 2026.11.0:**
    - macOS: `cloudflared-darwin-amd64.tgz`, `cloudflared-darwin-arm64.tgz`, `cloudflared-amd64.pkg`, `cloudflared-arm64.pkg`
    - Linux raw binaries: `cloudflared-linux-amd64`, `-arm64`, `-arm`, `-armhf`, `-386`, plus `cloudflared-fips-linux-amd64`
    - `.deb` packages: amd64, arm64, arm, armhf, 386, fips-amd64
    - `.rpm` packages: x86_64, aarch64, arm, armhf, 386, fips-x86_64
    - Windows: .exe and .msi for 386 and amd64
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0

2.2 **Checksums are SHA-256 and appear only in the release-notes body.** The body has a "### SHA256 Checksums:" block with one `name: hex` line per asset. There is no separate `SHA256SUMS` asset, so a downloader has to parse the release body (`gh api .../releases/latest --jq .body`). Example: `cloudflared-darwin-arm64.tgz: 97e24268d9704a570fab276293028f3580ae2c7d5d2678621a4809e90f776a5e`.
    https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0

2.3 **Signatures:**
    - No detached signature files (.sig, .asc, cosign, SLSA) are attached to GitHub releases (asset list in 2.1).
    - macOS: CI signs with a "Developer ID Application" certificate using `codesign ... --options runtime --timestamp` (hardened runtime). SRC`.ci/scripts/mac/build.sh` lines 135-183
    - **UNVERIFIED:** whether the macOS binaries are also notarized. No `notarytool` or `stapler` call was found in that script.
    - Linux: the .deb and .rpm repositories on pkg.cloudflare.com are GPG-signed. The repo file sets `gpgcheck=1` with `gpgkey=https://pkg.cloudflare.com/cloudflare-main.gpg`, and the apt repos are signed through reprepro `SignWith`. SRC`release_pkgs.py` lines 63-143, SRC`.ci/release.gitlab-ci.yml` lines 43-69
    - The docs downloads page gives no guidance on verifying checksums or signatures. https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/

2.4 **Homebrew:** `brew install cloudflared`. The formula is at `2026.11.0`, licensed Apache-2.0, and is a core formula with bottles. Bottles exist for `arm64_golden_gate`, `arm64_tahoe`, `arm64_sequoia`, `arm64_linux` and `x86_64_linux`. **There is no Intel macOS bottle**, so Intel Macs build from source or use the GitHub tgz.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ ,
    https://formulae.brew.sh/api/formula/cloudflared.json

2.5 **Package repositories (pkg.cloudflare.com):**
    - APT: the key is at `https://pkg.cloudflare.com/cloudflare-main.gpg`, and the repo line is `deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main`.
    - RPM: the repo file is at `https://pkg.cloudflare.com/cloudflared.repo`.
    - Note: Cloudflare rolled its signing key on 30 Oct 2025, and the old keys were to be removed 30 Apr 2026.
    https://pkg.cloudflare.com/

2.6 **Package installs disable self-update.** A package install writes the marker `/usr/local/etc/cloudflared/.installedFromPackageManager` (path from `config.DefaultUnixConfigLocation`), or the build sets `BuiltForPackageManager`. Either one turns self-update off. See 5.4.
    SRC`cmd/cloudflared/updater/update.go` lines 28-30, 283-298

### 3. `tunnel run` flags (source is authoritative)

Flag-name constants are in SRC`cmd/cloudflared/flags/flags.go`. Definitions are in SRC`cmd/cloudflared/tunnel/cmd.go`, SRC`cmd/cloudflared/tunnel/subcommands.go` and SRC`cmd/cloudflared/cliutil/logger.go`. Docs table: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

| Flag | Env var | Default (source) | Notes / source |
|---|---|---|---|
| `--token` | `TUNNEL_TOKEN` | none | "Also takes precedence over token-file". subcommands.go:127-131 |
| `--token-file` | `TUNNEL_TOKEN_FILE` | none | Reads the file and trims whitespace. subcommands.go:132-136, 769-779. **Added in 2025.4.0** ("feat: Adds a new command line for tunnel run for token file", RELEASE_NOTES line 336 under the 2025.4.0 header); the docs also say it "requires cloudflared version 2025.4.0 or later" |
| `--no-autoupdate` | `NO_AUTOUPDATE` | false | cmd.go:925-929 |
| `--autoupdate-freq` | (none) | 24h (`DefaultCheckUpdateFreq`) | cmd.go:919-922; update.go:25 |
| `--metrics` | `TUNNEL_METRICS` | `localhost:0`, which means try `localhost:20241`..`20245`, then a random port | cmd.go:939-950; metrics/metrics.go:31-53, 149-178 |
| `--loglevel` | `TUNNEL_LOGLEVEL` | `info`; allowed values {debug, info, warn, error, fatal} | cliutil/logger.go:28-32. The docs warn that `debug` logs request and response headers |
| `--logfile` | `TUNNEL_LOGFILE` | none | logger.go:41-44. The docs say cloudflared does not rotate this file |
| `--log-directory` | `TUNNEL_LOGDIRECTORY` | none | logger.go:47-50 |
| `--output` (log format) | `TUNNEL_MANAGEMENT_OUTPUT`, `TUNNEL_LOG_OUTPUT` | `default`; `json` also available | logger.go:18-21. **Useful for machine-parsing child logs** |
| `--protocol` | `TUNNEL_TRANSPORT_PROTOCOL` | `auto` (QUIC first, falls back to HTTP/2); `quic`, `http2` | subcommands.go:144-150 (hidden flag); connection/protocol.go:10,20 |
| `--edge-ip-version` | `TUNNEL_EDGE_IP_VERSION` | **`auto`** in source; {4, 6, auto} | cmd.go:680-684. **The docs table says default `4`. That is a doc/source discrepancy, and the source wins** |
| `--post-quantum` | `TUNNEL_POST_QUANTUM` | false | subcommands.go:152-156. The docs say it forces post-quantum key agreement on QUIC with no fallback and is not supported with `http2` |
| `--grace-period` | `TUNNEL_GRACE_PERIOD` | 30s, **max 3m** (`connection.MaxGracePeriod`); a larger value is an error | cmd.go:825-829; configuration.go:288-294; connection/connection.go:26 |
| `--retries` | `TUNNEL_RETRIES` | 5 | cmd.go:775-779 |
| `--management-diagnostics` | `TUNNEL_MANAGEMENT_DIAGNOSTICS` | **true** | Exposes /debug/pprof, /metrics etc. over the remote management service. cmd.go:890-893. **Not on the docs run-parameters page** |
| `--label` | (none) | "" | Connector label. Without it, the dashboard identifies a connector by hostname plus connector UUID. cmd.go:820-822. **Not on the docs page** |
| `--pidfile` | `TUNNEL_PIDFILE` | none | Writes the PID "after first successful connection". cmd.go:952-955 |
| `--no-prechecks` | `TUNNEL_NO_PRECHECKS` | false | Skips connectivity pre-checks at startup. cmd.go:932-936 |
| `--ha-connections` | (none) | 4 (hidden) | cmd.go:782-784 |

3.1 **Token handling. Use the environment variable or `--token-file`, never `--token` on argv.** Cloudflare's own service installers moved from `--token` to `--token-file` in 2026 and filed this as security fixes:
    - Linux service, VULN-118896, 2026.7.2
    - macOS service, VULN-118896, 2026.7.2
    - Windows service, VULN-143514, 2026.7.3
    Arguments on argv are visible to other local users through `ps`. Cloudflare also removed `cmdline` from the metrics server's debug endpoints because it "publish[es] os.Args and thus secrets such as tunnel tokens".
    SRC`RELEASE_NOTES` lines 126-136; SRC`metrics/metrics.go` lines 101-112; SRC`cmd/cloudflared/common_service.go` line 79

3.2 **The token is redacted in cloudflared's own logs and diagnostics.** The values of `token` and `credentials-contents` (flag and env var) are replaced by `*****`. `token-file` is not redacted, but its value is only a path.
    SRC`cmd/cloudflared/tunnel/configuration.go` lines 36-46, 60-100

3.3 **An invalid token fails fast.** It returns the usage error "Provided Tunnel token is not valid.", which exits with code -1, seen as 255. See 5.1.
    SRC`cmd/cloudflared/tunnel/subcommands.go` lines 781-785

### 4. Metrics server endpoints

The routes are registered in SRC`metrics/metrics.go` lines 68-99 and SRC`diagnostic/handlers.go` lines 111-114.

4.1 **`/ready`**:
    - Returns HTTP 200 when at least one edge connection is active, otherwise 503.
    - The body is JSON `{"status":<code>,"readyConnections":<n>,"connectorId":"<uuid>"}`.
    - The handler comment says it is "Intended for k8s readiness checks."
    - There is also a `cloudflared tunnel ready --metrics <addr>` subcommand that calls /ready and exits non-zero on anything but 200. It requires `--metrics`.
    SRC`metrics/readiness.go` lines 13-60; SRC`cmd/cloudflared/tunnel/subcommands.go` lines 467-504.
    - **The docs metrics page does not mention /ready or /healthcheck.** The source is the only authority here.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/

4.2 **`/metrics`**: Prometheus exposition through `promhttp.Handler()`. The docs list roughly 50 metrics, for example `cloudflared_tunnel_total_requests`, plus Go runtime metrics. `build_info{version=...}` is registered.
    SRC`metrics/metrics.go` lines 75, 218-229; docs metrics page above

4.3 **`/healthcheck`**: always returns `OK\n`. It is a liveness check only, not a sign that the tunnel is connected.
    SRC`metrics/metrics.go` lines 76-78

4.4 **`/quicktunnel`**: returns `{"hostname":"..."}` for TryCloudflare quick tunnels. For a named or token tunnel the hostname is empty.
    SRC`metrics/metrics.go` lines 82-84

4.5 **Other routes on the same listener:**
    - `/config`: the versioned remote ingress configuration as JSON.
    - `/diag/configuration`: CLI flags with secrets redacted, plus the uid.
    - `/diag/tunnel`, `/diag/system`, `/diag/precheck`
    - `/debug/pprof/*` and `GET /debug/vars`: an allowlist that is memstats only since 2026.10.4.
    The listener has no authentication. **On loopback, any local user can read the ingress config and profiles.** That matters on multi-user hosts.
    SRC`metrics/metrics.go` lines 85-124; SRC`diagnostic/consts.go` lines 18-25; SRC`RELEASE_NOTES` line 28

4.6 **Default address and port range.** Outside containers the default binds `localhost:20241` through `20245`, the first one free, then a random port. In "virtual" (container) builds it binds `0.0.0.0` on the same ports. The log line "Starting metrics server on <addr>/metrics" reports the address actually chosen. **A supervisor should pass an explicit `--metrics 127.0.0.1:<port>`** so it does not race other cloudflared instances for 20241-20245.
    SRC`metrics/metrics.go` lines 28-53, 144-178, 196; docs metrics page above

### 5. Exit codes, signals, autoupdate, privileges, ICMP

5.1 **Exit codes, from source:**
    - Usage or validation errors exit with -1, which the process sees as 255. SRC`cmd/cloudflared/cliutil/errors.go` lines 25-37
    - Any other returned error exits with 1. Same file; SRC`cmd/cloudflared/cliutil/handler.go` line 36
    - Self-update succeeded: exit **11**. Self-update failed: exit **10**. SRC`cmd/cloudflared/updater/update.go` lines 41-70
    - **Inferred, not tested:** a graceful shutdown on a signal returns nil from `waitToShutdown`, so the exit code is 0. SRC`cmd/cloudflared/tunnel/cmd.go` lines 565-600
    - No official doc lists exit codes. **UNVERIFIED** beyond reading the source.

5.2 **Signals:**
    - SIGTERM and SIGINT both start a graceful shutdown. The log says "Initiating graceful shutdown due to signal ...". SRC`cmd/cloudflared/tunnel/signal.go` lines 12-23
    - The flag help says cloudflared "will stop accepting new requests, wait for in-progress requests to terminate, then shutdown. Waiting for in-progress requests will timeout after this grace period, or when a second SIGTERM/SIGINT is received." The default period is 30s, the maximum 3m. SRC`cmd/cloudflared/tunnel/cmd.go` lines 825-829
    - The handler calls `signal.Stop` after the first signal, so a second signal gets Go's default disposition and terminates the process immediately. That matches the help text.
    - **Supervisor advice:** send SIGTERM, wait slightly longer than `--grace-period`, then SIGKILL. Or pass a short `--grace-period` such as 5s for snappy stops.

5.3 **Autoupdate stays on in a supervised child unless you turn it off.** `supportAutoUpdate` disables updates only in these cases:
    - On Windows.
    - When a package-manager marker is present or the build is a package-manager build.
    - When **stdout is a TTY** (`term.IsTerminal(os.Stdout)`).
    SRC`cmd/cloudflared/updater/update.go` lines 271-303

    A child whose stdout is piped is not a TTY, so a raw GitHub binary self-updates every 24h by default:
    - It downloads from `update.argotunnel.com` / github.com.
    - It replaces its own binary.
    - It exits with **code 11**. Under SysV it re-execs itself first.
    SRC`update.go` lines 241-268; firewall doc below lists the update hosts

    **Pass `--no-autoupdate` (or `NO_AUTOUPDATE=true`) and manage versions yourself.** Cloudflare's own container images set `ENV NO_AUTOUPDATE=true` (TUN-11051, 2026.10.6). SRC`Dockerfile.amd64` line 38; SRC`RELEASE_NOTES` lines 11-14

    The docs agree that `--no-autoupdate` "Doesn't apply on Windows, package-manager installs, or interactive terminal runs" because updates are already off there.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/

5.4 **The non-TTY check also shows up in `RunFromTerminal`,** which is passed into the supervisor config. SRC`cmd/cloudflared/tunnel/configuration.go` lines 246, 296-298

5.5 **Root is not needed for `tunnel run`.**
    - The only `Geteuid()==0` check in the codebase is in the macOS *service install* path. SRC`cmd/cloudflared/macos_service.go` line 91
    - The tunnel makes only outbound connections: port **7844 TCP+UDP** to `region1/region2.v2.argotunnel.com`, plus optional 443 to `api.cloudflare.com`, `update.argotunnel.com` and `github.com` for updates.
    https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

5.6 **ICMP proxy warnings on Linux are harmless for HTTP-only use.**
    - cloudflared opens unprivileged ICMP ("ping") sockets.
    - If the process GID is outside `/proc/sys/net/ipv4/ping_group_range` it warns: "The user running cloudflared process has a GID (group ID) that is not within ping_group_range... Otherwise cloudflared will not be able to ping this network".
    - It then logs "ICMP proxy feature is disabled" and **continues running**.
    - ICMP proxying only matters for WARP private-network routing, not for an HTTP public hostname.
    SRC`ingress/icmp_linux.go` lines 30, 57-61; SRC`cmd/cloudflared/tunnel/configuration.go` lines 260-265; issue example https://github.com/cloudflare/cloudflared/issues/1158

    **UNVERIFIED:** the exact developers.cloudflare.com page that documents the ping_group_range fix. The search surfaced a summary but no stable URL.

### 6. Embedding as a library

6.1 **No official statement found that cloudflared supports use as a Go library. Treat this as UNVERIFIED / unsupported.**
    - The README describes it only as a "command-line client" and daemon, and documents only CLI-level compatibility guarantees (1.6). SRC`README.md`
    - The module path is `github.com/cloudflare/cloudflared`, built with Go 1.27.4. SRC`go.mod`
    - The release tags are `YYYY.M.N` with no `v` prefix. Go modules only recognise `vMAJOR.MINOR.PATCH` tags as versions, so `go get` resolves to pseudo-versions and there is no semver API contract. https://go.dev/ref/mod#versions
    - The supported integration surface is therefore the CLI, its flags and env vars, and the metrics endpoints.

### 7. Remote visibility of connectors

7.1 **The API exposes per-connector details.** `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/connections` returns:
    - per connector: `id`, `arch` ("The cloudflared OS architecture used to establish this connection"), `version`, `run_at`, `config_version`, `features`
    - per connection (`conns[]`): `client_id` ("UUID of the Cloudflare Tunnel connector"), `client_version`, `colo_name`, `opened_at`, `origin_ip` ("The public IP address of the host running cloudflared")
    A per-connector endpoint `.../connectors/{connector_id}` also exists.
    https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/subresources/connections/methods/get/ ,
    https://developers.cloudflare.com/api/resources/zero_trust/subresources/tunnels/subresources/cloudflared/methods/get

7.2 **The dashboard shows the same data.** Cloudflare's blog: expanding a tunnel shows its replicas' "connection status, data center, IP address, and version". The connector is labelled with the machine hostname plus connector ID unless `--label` is given (3, cmd.go:820-822).
    https://blog.cloudflare.com/observe-and-manage-cloudflare-tunnel/

    **UNVERIFIED:** the current dashboard layout. The blog post is older.

7.3 **Remote management can reach the connector.** It uses `management.argotunnel.com` (hidden flag `--management-hostname`). With `--management-diagnostics` (default **true**), a remote admin can pull /metrics and /debug/pprof through it. This is what powers dashboard log streaming and `cloudflared tail`.
    SRC`cmd/cloudflared/tunnel/cmd.go` lines 890-893, 1083-1087

    **Privacy-conscious deployments may want `--management-diagnostics=false`.** That is a judgment call, not Cloudflare guidance.

## Part B: data handling

### 8. Plaintext visibility and E2E options

8.1 **Cloudflare decrypts TLS at its edge.** The clearest official wording is in the Data Localization Suite docs:
    - TLS termination is "the point at which encrypted HTTPS traffic is decrypted".
    - "functions that require access to decrypted traffic are applied only at in-region Cloudflare locations".
    - For Enterprise products covered by Regional Services, Cloudflare "will only terminate TLS connections for these products in the geographic region you have configured".
    The product exists to control *where* Cloudflare decrypts, which presupposes that it does.
    https://developers.cloudflare.com/data-localization/regional-services/

8.2 **Edge certificates terminate the visitor's TLS at Cloudflare.** "Edge certificates are the SSL/TLS certificates that Cloudflare presents to visitors connecting to your domain... These certificates secure the encrypted connection between your visitors and Cloudflare."
    https://developers.cloudflare.com/ssl/edge-certificates/

    The SSL modes page describes "two connections": visitor to Cloudflare, and Cloudflare to origin.
    https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/

    "How Cloudflare works" describes the reverse proxy, which "can be configured to decrypt all incoming requests ... [and] cache content".
    https://developers.cloudflare.com/fundamentals/concepts/how-cloudflare-works/

8.3 **For a Tunnel public hostname (an HTTP service such as `http://127.0.0.1:3890`), the request is plaintext HTTP at Cloudflare.**
    - The visitor's TLS ends at the edge certificate (8.2).
    - The edge forwards the request over the cloudflared connection, which is TLS/QUIC to 7844.
    - cloudflared then makes a fresh local request to the origin. FAQ: "When using Cloudflare Tunnel, all requests to the origin are made internally between `cloudflared` and the origin."
    https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/

    **Explicit statement UNVERIFIED:** no single developers.cloudflare.com page says "Tunnel HTTP traffic is visible in plaintext to Cloudflare" in those words. It follows from 8.1 and 8.2, and from HTTP-layer features (WAF, Access, caching) being applied to Tunnel hostnames.

8.4 **The privacy policy describes Cloudflare's role, not its access.** It says "Cloudflare is a data processor for any of the content provided by Customers and End Users ... through the Services that transits, or in some cases, is stored on, the Cloudflare network" and "We are a conduit for information controlled by others." It does not state whether staff or systems inspect proxied content.
    https://www.cloudflare.com/privacypolicy/

8.5 **Keyless SSL does not give end-to-end encryption.** It keeps only the *private key* on customer infrastructure ("Keep private keys on your own infrastructure while using Cloudflare TLS"). The handshake still completes at Cloudflare, which derives the session keys. The technical blog explains that the key server only performs the private-key operation.
    https://developers.cloudflare.com/ssl/keyless-ssl/ ,
    https://blog.cloudflare.com/keyless-ssl-the-nitty-gritty-technical-details/
    (Cloudflare's learning page returned 403 to the fetcher.)

8.6 **E2E-ish options. Each needs the application to carry its own TLS, so Cloudflare relays ciphertext at Layer 4:**
    - **Arbitrary TCP via Tunnel plus `cloudflared access tcp` on the client.** The tunnel publishes a `tcp://` service, and the client runs `cloudflared access tcp --hostname ... --url localhost:PORT`. Cloudflare proxies the TCP bytes. If the origin itself speaks TLS (for example, the app serves HTTPS with its own cert), Cloudflare sees only the outer stream. Cost: every client must install cloudflared.
      https://developers.cloudflare.com/access/other-protocols/tcp-guide , SRC`README.md` ("access Tunnel origins ... for TCP traffic at Layer 4")
    - **WARP client plus Tunnel private-network routing.** The client reaches the origin's private IP at L4. **Gateway TLS decryption is a separate setting.** Docs: when it is off, "information contained within HTTPS encryption, such as the full URL, headers, and request body, will not be visible to Gateway". When it is on, "Gateway ... terminates the connection from the client and creates a new connection to the origin server". With decryption off and app-level TLS, the payload stays opaque to Cloudflare.
      https://developers.cloudflare.com/cloudflare-one/traffic-policies/http-policies/tls-decryption/
    - **Application-layer E2E** (payload encryption inside HTTP) works over any of these. It is not a Cloudflare feature.

    **UNVERIFIED:** whether Gateway TLS decryption is off by default. The page describes it as a setting you turn on but does not state the default.

## Implications for a supervisor (synthesis, not sourced claims)

- Pin and verify the binary: parse the SHA-256 checksums from the release body.
- Run `cloudflared tunnel run --no-autoupdate --metrics 127.0.0.1:<port> --output json --grace-period 5s`.
- Pass the token through the `TUNNEL_TOKEN` env var or `--token-file` (0600). Never put it on argv.
- Poll `/ready` for `readyConnections > 0`. Treat exit 11 or 10 as "something self-updated" (it should not happen with `--no-autoupdate`).
- Stop with SIGTERM, then SIGKILL after the grace period.
- Tell users plainly that a remotely managed HTTP tunnel gives Cloudflare plaintext access to every request and response, including any auth headers and cookies yaran uses.

---

# Design constraints & recommendations

## Hard constraints (from the facts above)
1. **Tunnel lifecycle.** Create with `POST /accounts/{id}/cfd_tunnel {name, config_src:"cloudflare"}`; the server generates the secret. Fetch the token with `GET .../cfd_tunnel/{id}/token`, which needs Tunnel *Edit*. Set ingress with `PUT .../configurations`. This replaces the whole config, so send `[{hostname, service:"http://localhost:3890", originRequest:{...}}, {service:"http_status:404"}]`. The PUT never creates DNS. Deleting a tunnel requires zero active connections, so call `DELETE .../connections` first. It also does not remove the CNAME. Limits: 1,000 tunnels per account, 25 replicas per tunnel. WebSockets work with no extra setting.
2. **DNS.** Use a proxied CNAME `<machine>.<zone>` → `<uuid>.cfargotunnel.com`, in the same account. Keep hostnames **one label deep**, because free Universal SSL does not cover `a.b.zone`. The "hostname routes" API (`/zerotrust/routes/hostname`) is for private WARP routing, not public publishing, so do not use it here.
3. **Access is the only authentication in the path, so it must fail closed.** For every machine:
   - a hostname-based self-hosted app, plus `originRequest.access {required:true, teamName, audTag}` in the tunnel ingress, so cloudflared itself rejects requests that carry no valid Access JWT;
   - new apps take only **reusable policies**, attached by id with a precedence;
   - account caps: 500 apps, 500 reusable policies, 50 service tokens. One app and one policy per machine caps an account at about 500 machines. **Per-device service tokens do not scale**, since 50 is the account cap.
4. **The Free Zero Trust plan** gives 50 seats and still needs a payment method on file. New orgs default to the Cloudflare-account IdP, so the setup flow must add One-time PIN, GitHub or Google before non-member developers can log in. Detect this with `GET /access/identity_providers`.
5. **Non-browser clients.** By default they get a 302 to an interactive login they cannot complete. CORS preflights get a 403 unless `options_preflight_bypass` or `cors_headers` is set. Strict service-token mode is on for new orgs.
6. **JWT validation in the Worker.**
   - Verify the `Cf-Access-Jwt-Assertion` header, never the cookie. Keys are RS256, from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, and rotate every 6 weeks with 7 days of overlap. Check `iss`, `aud` (the app's AUD) and `exp`.
   - Use `jose`, with `createRemoteJWKSet` created **once at module scope**.
   - Service-token JWTs have no `email`, `sub` is empty, and `common_name` holds the client id. **Authorize on `email`/`sub` and reject service-token JWTs on user routes.**
7. **Same-zone fetch bypasses Access (highest risk).** A Worker `fetch()` to a hostname in its own zone defaults to going straight to the origin, "bypassing Cloudflare security settings", unless the `global_fetch_strictly_public` compatibility flag is set. If the Worker proxies to machine hostnames:
   - set that flag, **or** keep `originRequest.access.required=true` on cloudflared so the origin edge still demands a JWT;
   - treat this as UNVERIFIED until tested live.
8. **Token template.** Use the account-owned template URL form `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=[...]&name=...`, keyed by **permission group IDs**. The UI flags any ID it cannot resolve, while the user-token form silently drops unknown short keys. Official short keys do not exist for Tunnel or Access Service Tokens.
   - Minimal set: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Account Settings Read, DNS Edit and Zone Read (zone-scoped). Add Access: Organizations/IdP Read for the IdP check, and Access: Service Tokens Edit only if service tokens are used.
   - Resolve the IDs once with `GET /accounts/{id}/tokens/permission_groups` before freezing the link; the IDs gathered so far come from an unofficial datamine.
   - Do not grant "API Tokens Edit" so the Worker can mint tokens itself; Cloudflare's docs advise against it.
9. **API budget.** 1,200 requests per 5 minutes per token. Provisioning one machine costs about 6 to 8 calls. Polling tunnel status for N machines from Cron (minimum interval 1 minute; 5 crons per account on Free) must use a list call rather than one call per machine.
10. **Deploy button.**
    - Needs a public github.com or gitlab.com repo; a subdirectory is given as `/tree/main/<dir>`.
    - D1, KV, Durable Objects, Queues and similar are provisioned automatically. Secrets are prompted from `.dev.vars.example`, and binding descriptions come from `package.json` → `cloudflare.bindings`.
    - D1 migrations run only if the repo's `deploy` script runs them.
    - The deployer gets a **cloned copy** of the repo, built by Workers Builds. Upstream updates are not automatic (UNVERIFIED that no sync exists), so ship an "update available" check plus documentation.
11. **Workers limits.**
    - Free: 10 ms CPU and 50 subrequests per request. Paid: 30 s CPU (up to 5 min) and 10,000 subrequests.
    - 6 simultaneous outbound connections per request.
    - A Worker-proxied WebSocket is dropped on runtime updates, after up to about 20 minutes, so clients must reconnect.
    - Durable Objects work on Free with SQLite. Hibernation covers only sockets the DO *accepts*, not ones it opens to an origin, so proxied sockets keep the DO billed.
    - D1 Free: 10 databases, 500 MB each, 5M rows read and 100k rows written per day.
    - Secrets Store is still beta, so use plain Worker secrets. The Rate Limiting binding is GA but approximate and counted per location.
12. **Push.**
    - FCM HTTP v1 works over HTTP/1.1, with a service-account JWT signed through WebCrypto.
    - APNs requires HTTP/2. A deployed Worker's `fetch` is upgraded to HTTP/2 by the edge (Kenton Varda, workerd issue #4841), so token-based (.p8 JWT) APNs is reported to work in production. It fails in local `wrangler dev`, and **no documented guarantee exists**. Test early and keep a fallback relay in mind.
    - mTLS (certificate) APNs auth is not viable; use .p8 tokens.
13. **cloudflared as a child process.**
    - Apache-2.0. Version tags look like `YYYY.M.N` (latest 2026.11.0, about 30 releases a year). Versions within one year of the latest are supported.
    - **Always pass `--no-autoupdate`.** Otherwise, with stdout not a TTY, it replaces itself and exits with code 11.
    - Pass the token through `TUNNEL_TOKEN` or `--token-file` (2025.4.0+). Never put it in argv.
    - Bind `--metrics 127.0.0.1:<port>` explicitly. The endpoint is unauthenticated and exposes config and pprof data; the default is the first free port in 20241–20245.
    - Supervise using `/ready` (200 with `readyConnections`, otherwise 503).
    - Stop with SIGTERM and a `--grace-period` (default 30 s, max 3 min); a second signal kills it.
    - Runs unprivileged.
    - Pin a version, and verify the SHA-256 from the release notes (the only place checksums are published). macOS binaries are Developer ID signed; the apt/rpm repos are GPG signed.
    - No supported library API, so do not embed it.
14. **Data handling.** Cloudflare terminates TLS at its edge, so tunneled HTTP and WebSocket traffic (terminal I/O, file contents) is visible in plaintext to Cloudflare. The only end-to-end options are Layer 4: `cloudflared access tcp`, or WARP private routing with yaran's own TLS. Both break the browser and mobile HTTPS-hostname model. State this plainly in the docs and the threat model.

## Recommendations
- **Mobile authentication: use Access Managed OAuth** (opt-in per app via `oauth_configuration.enabled`).
  - It works through dynamic client registration, PKCE, a system browser, private-use-scheme redirects, opaque `oauth:` bearer tokens (15 minutes by default) and refresh tokens. The origin still receives a normal `Cf-Access-Jwt-Assertion`.
  - **Before committing, test whether a WebSocket upgrade with `Authorization: Bearer oauth:...` is accepted** (UNVERIFIED).
  - Fallback: route mobile traffic through the Worker under one hostname, with the Worker holding a per-machine service token. The 50-token cap and the same-zone bypass caveat apply.
  - Do not reimplement the undocumented cloudflared transfer protocol (`login.cloudflareaccess.org/transfer/...`).
  - Cookie extraction through ASWebAuthenticationSession or Custom Tabs is not possible.
- **Prefer direct per-machine hostnames over Worker path-proxying.** Path-proxying adds the same-zone Access bypass hazard, WebSocket drops on runtime updates, Durable Object costs (because proxied sockets cannot hibernate), and Workers CPU and connection limits. If a single hostname is needed, the Worker must re-authenticate the user itself and forward with `global_fetch_strictly_public`. cloudflared must still enforce `access.required`.
- **Make provisioning idempotent and garbage-collected.** Key resources by machine id in D1, and run cleanup in this order: app → policy → DNS → connections → tunnel. A periodic sweep reconciles orphans against the list endpoints.
- **Isolate the Worker's own surface:** set `workers_dev = false` and `preview_urls = false`, serve on a custom domain, and put a separate Access app in front of the admin and pairing UI.
- **Token secrecy on the developer machine:** store the tunnel token owner-only in yaran's config directory (matching the file-modes tenet), pass it to cloudflared through `--token-file`, and rotate by PATCHing `tunnel_secret` (the old token stops making NEW connections but live connectors keep serving), re-deliver the token, and on compromise follow with `DELETE ./connections` (Part 1, section 1.8).
