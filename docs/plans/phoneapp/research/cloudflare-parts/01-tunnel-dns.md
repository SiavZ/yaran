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
