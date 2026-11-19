# Phase 05 — Org Worker: Cloudflare provisioning engine and reconciliation

**Track:** Wave B (org control plane) · **Parallel-safe with:** 04 (against its fixed seams), 06, 07, 08, 09–18
**Depends on:** 04 (D1 schema, `machines` repository, dispatcher, logger, sanitizer, secrets), 02 (error codes, claim fields, `OriginUpdate`, `Settings`, audit registry), 03 (G2 ingress shape and cloudflared floor, G1 for the fallback-L2 OAuth fields; primary and fallback both specified here) · **Blocks:** 06 (provisioning at pairing, token delivery, status cache), 07 (token-permission list, quota settings, admin repair/revoke actions), 19

## Goal

Give the org Worker one engine that turns "this user's machine should exist" into
Cloudflare resources and back again, safely under every failure.

For each machine the engine manages:

- a reusable owner-only Access policy;
- a self-hosted Access app;
- a remotely managed tunnel with a per-route `originRequest.access` ingress rule;
- a proxied CNAME.

All of that sits on one hostname, `<machine>-<user>.<zone>` (D1, D2, D4).

Every operation must be:

- **idempotent:** a retry never duplicates a resource;
- **resumable:** a crash at any point converges on the next drive;
- **serialized per machine;**
- **ordered** so the hostname is never published without Access in front of it (D21:
  provision policy → Access app → tunnel → ingress → DNS; teardown DNS → tunnel
  connections → tunnel → Access app → policy).

A cron reconciler keeps the live status cache that machine lists read, repairs drift,
and removes orphans. It runs within the Cloudflare API budget (1,200 calls per 5 min per
token) and the Workers Free plan limits.

## Evidence

All Cloudflare facts were fetched 2026-11-14.

- **Schema source.** The endpoint and field facts not otherwise cited come from
  Cloudflare's OpenAPI schema `github.com/cloudflare/api-schemas/openapi.json` (commit
  2026-11-13). The developers.cloudflare.com API reference pages are generated from it and
  carry no date. Field names were cross-checked against `cloudflare-typescript`.
  - Local copy: `/private/tmp/claude-501/-Users-siavash-Projects-yaran/4dd4e71a-831c-455a-a742-422e6c0a71dc/scratchpad/cfapi/openapi.json`.
- **Tunnels** (R4 Part 1 §1.1–1.8, sources S1–S12 listed there):
  - **Create:** `POST /accounts/{a}/cfd_tunnel {name, config_src:"cloudflare"}`. The
    server generates the secret. A duplicate name returns 409.
  - **Token:** `GET …/{id}/token`, which needs Write permission. The `result` is a string.
  - **Ingress:** `PUT …/{id}/configurations` replaces the whole config. Response
    `result.version`.
  - **Rotate:** `PATCH …/{id} {tunnel_secret}`. After rotation the old token cannot open
    new connections, but existing connectors stay.
  - **Connections:** `DELETE …/{id}/connections` removes connectors.
  - **Delete:** `DELETE …/{id}` requires zero active connections.
  - `cascade` is used only by cloudflared's client (`cfapi/tunnel.go`) and is not in the
    API reference.
  - **List:** `GET /accounts/{a}/cfd_tunnel`. Filters: `name`, `uuid`, `is_deleted`,
    `include_prefix`, `exclude_prefix`, `status`. `per_page` max 1000.
  - **Status:** `inactive|degraded|healthy|down`, plus `conns_active_at` and
    `conns_inactive_at`.
  - `connections` was removed from list and get responses on 2026-10-05, and the schema
    still says "empty array". Source:
    https://developers.cloudflare.com/changelog/post/2026-07-09-tunnel-routes-and-connections-api-changes/
  - **Limits:** 1,000 tunnels per account, 25 replicas, 1 MB config (R4 §1.7).
- **DNS:**
  - **Create:** `POST /zones/{z}/dns_records` with `{type:"CNAME", name, content:"<uuid>.cfargotunnel.com", proxied:true, ttl:1, comment}`.
    The record must be proxied: `cfargotunnel.com` resolves only to a ULA AAAA record
    (R4 §2.1–2.2).
  - **List filters:** `name` (alias of `name.exact`, case-insensitive), `type`,
    `comment.startswith`, `comment.exact` and more.
  - **Pagination:** `per_page` defaults to 100. The schema's maximum reads "5,000,000"
    and is quoted as written.
  - **Record by id:** `GET|PATCH|PUT|DELETE …/dns_records/{id}`.
  - **Limits:** comments are at most 100 characters on Free; tags are not available on
    Free (https://developers.cloudflare.com/dns/manage-dns-records/reference/record-attributes/,
    2026-08-14).
  - **Conflicts:** a CNAME is refused when an A, AAAA or CNAME already holds the name
    (https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/records-with-same-name/,
    2026-07-20). The conflict error codes 81053/81054/81057/81058 come from third-party
    sources only: **UNVERIFIED**.
- **Access apps** (R4 Part 2 §1):
  - **Create:** `POST /accounts/{a}/access/apps`. The body uses `type:"self_hosted"`,
    `domain`, `destinations:[{type:"public", uri}]`, `session_duration` (a Go duration;
    the app default is `24h`), `enable_binding_cookie` (default false),
    `http_only_cookie_attribute` (default true), `same_site_cookie_attribute` (no
    documented default), `app_launcher_visible`, and
    `policies:[{id, precedence}]`. Reusable and inline policies are mutually exclusive.
  - **List:** query params `name`, `domain`, `aud`, `exact`, `search`, `page`,
    `per_page` (max 1000).
  - **Get / replace:** `GET|PUT …/apps/{id}`. There is no PATCH, so a PUT sends the whole
    object.
  - **Delete:** `DELETE` returns 202 with `{id}`.
  - The AUD never changes unless the app is recreated.
- **Access policies:**
  - **Create:** `POST /accounts/{a}/access/policies {name, decision:"allow", include:[{email:{email}}]}`.
  - **List:** only `page` and `per_page` (max 1000). There is no name filter.
  - **Replace / delete:** `PUT|DELETE …/policies/{id}`.
  - `app_count` is in the response.
  - A policy must be detached from every app before deletion
    (https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/,
    2026-11-02). The API's error for an attached policy is **UNVERIFIED**.
  - **Account limits:** 500 apps, 500 reusable policies, 50 service tokens
    (https://developers.cloudflare.com/cloudflare-one/account-limits/, 2026-11-05).
- **Deploy order.** "If you publish a tunnel route before creating an Access application,
  the app is reachable by anyone on the Internet" (self-hosted-public-app page,
  2026-04-17, R4 Part 2 §1).
- **API rate limit:** 1,200 requests per 5 min per token, and 200 per second per IP. Going
  over blocks all calls for 5 min with HTTP 429.
  - Headers: `Ratelimit: "<name>";r=<remaining>;t=<seconds>`,
    `Ratelimit-Policy: "<name>";q=<quota>;w=<window>`, and `retry-after` on a 429 only
    (https://developers.cloudflare.com/fundamentals/api/reference/limits/, 2026-08-25).
- **Pagination.** Envelope `{success, errors:[{code,message}], messages, result,
  result_info:{page, per_page, count, total_count[, total_pages]}}`. Every endpoint here
  is page-based; none uses a cursor.
- **Workers limits:**
  - Free: 10 ms CPU per request and per cron run, excluding I/O; 50 external subrequests;
    50 D1 queries per invocation, where a `batch()` counts as one.
  - Paid: 30 s CPU.
  - Sources: https://developers.cloudflare.com/workers/platform/limits/ (2026-11-13);
    https://developers.cloudflare.com/d1/platform/limits/ (2026-10-30).
- **Repository:**
  - yaran's web port is configurable: `[server] port`, default 3890
    (`crates/yaran-core/src/config.rs:883`, `:2242`). The ingress target therefore comes
    from the machine, not a constant.
  - A rewritten `Host` breaks every mutation and WebSocket (R1 §3 table row at
    `research/R1-server-core-cli.md:238`). That is why no `httpHostHeader` is set (D4).

## In scope

- A typed Cloudflare API client:
  - transport and timeouts;
  - envelope parsing and error classification;
  - retries for idempotent methods;
  - pagination;
  - rate-limit budget accounting with priorities.
- Naming: user and machine slugs, hostnames, collision handling, and the per-instance
  resource markers.
- Desired-state builders and comparators for the policy, app, ingress and DNS record.
- The saga engine (ops, leases, steps, backoff, compensation) and the four operations:
  `provision`, `teardown`, `rotate`, `repair`.
- Tunnel-token fetch, without storing the token.
- Changing the origin port (W4 claim and W32 `PUT /v1/machine/origin`), including a port
  change that lands while another op is live.
- The quota guard.
- Reconciliation tasks: status cache, drift repair, orphan sweep, and driving stalled ops.
- The fake Cloudflare used by tests, recorded API fixtures, and the recorder script.

## Out of scope

- Who may pair, the pairing UX, claim, delivering a token to yaran, and the per-user
  machine cap: **06**, which calls this phase's facade.
- The setup wizard and token verification, the control-plane Access app, and the admin
  and user console buttons for revoke, rotate and repair: **07**.
- The D1 DDL, settings storage, dispatcher, logger and audit: **04**. This phase uses them
  and adds rows to the task and action registries.
- Machine-side handling of `machine_revoked` or a new tunnel generation: **09**, **10**.
- Live proof of the UNVERIFIED API behaviours: **03** (gate scripts) and **19**
  (staging). This phase's design already covers both outcomes.

## Design

### 1. Cloudflare API client (`src/cloudflare/`)

**Transport (`client.ts`):**

- Base URL from the Worker var `CF_API_BASE_URL` (07's deploy tree declares it with an
  inline comment), default `https://api.cloudflare.com/client/v4` when unset (Phase 19 hook
  H3: staging interposes its chaos proxy here). The value must be `https:`; anything else
  is refused at startup with a logged error, so a typo can never send the token in clear.
- Headers: `Authorization: Bearer <CF_API_TOKEN>`, `User-Agent: yaran-cloud/<version>`.
- A 10 s timeout via `AbortController`.
- Parses the envelope. A non-JSON body is an error carrying the status.

**Errors (`errors.ts`).** One `CfApiError` with an exhaustive `kind`:

| kind | Trigger | Saga treatment | Wire code when surfaced (02 §4) |
|---|---|---|---|
| `rate_limited` | 429 | Record `blocked_until = now + retry-after`, reschedule | `cloudflare_rate_limited` (503, `Retry-After`) |
| `transient` | 5xx, network, timeout, non-JSON | Backoff and retry | `cloudflare_unavailable` (502) |
| `not_found` | 404 | Per step: "already gone" or "recreate" | none (handled) |
| `conflict` | 409, or any DNS `8105x` code (UNVERIFIED list, matched by range) | Adopt-by-marker, else hostname conflict | `hostname_conflict` (409) |
| `auth` | 401/403 | Permanent; admin-visible "token lacks permission X" naming the endpoint | `cloudflare_permission_denied` (502, `details.permission`) |
| `invalid` | Other 4xx | Permanent; message sanitized via 04's sanitizer | `cloudflare_api_failed` (502, sanitized `details.cf_errors`) |

A saga that fails permanently and compensates surfaces `provisioning_failed` (502) to the
waiting page unless one of the codes above is more specific; a quota refusal surfaces
`account_quota_reached` (§9).

**Retries.** `GET`, `PUT` and `DELETE` retry `transient` errors up to 2 times inside the
call, with full jitter between 200 and 1,500 ms. `POST` and `PATCH` are never retried
inside the client: the saga's adopt step makes them safe, as §4 explains.

**Budget (`budget.ts`):**

- Parses `Ratelimit` into remaining (`r`) and reset (`t`).
- Writes `cf_api_budget` at most once per invocation, coalesced at the end.
- Every call declares a priority, which a gate enforces before the network call:
  - `interactive` (user-triggered provision, teardown, rotate, token fetch) runs while
    `remaining > 20`;
  - `background` (reconcile) runs only while `remaining > api_background_reserve`
    (setting, default 600, which is half the window).
- A known `blocked_until` throws `rate_limited` before any network call. The Worker never
  spends a call it knows will 429.

**Pagination (`paginate.ts`).** Page-based `listAll` with a `maxPages` guard and
`total_count` checks.

**Endpoint modules.** Typed functions only, each declaring the minimal response subset it
reads in `types.ts`:

- `tunnels.ts`: `create`, `get`, `list`, `rotateSecret`, `getToken`, `putConfig`,
  `getConfig`, `deleteConnections`, `remove`.
- `dns.ts`: `findByName`, `listByCommentPrefix`, `get`, `create`, `patch`, `remove`.
- `access.ts`: apps (`findByDomain`, `list`, `get`, `create`, `replace`, `remove`) and
  policies (`list`, `get`, `create`, `replace`, `remove`).

**`token` in rotate and create responses.** The API schema omits it, while the tutorial
and the cloudflared source show it (R4 §1.1, §1.8). The client reads `result.token` when
present and otherwise falls back to `GET …/token`, so either outcome works.

**Token permissions this engine needs.** They feed 07's template and G9:

| Permission | Scope | Used for |
|---|---|---|
| Cloudflare Tunnel Edit | Account | Tunnels |
| Access: Apps and Policies Edit | Account | Access apps and policies |
| DNS Edit | Zone | DNS records |
| Zone Read | Zone | Zone status check |

Explicitly **not** needed:

- Access service tokens, which D6 rules out;
- Workers Scripts, so the token cannot rewrite the Worker;
- any token-minting permission.

### 2. Naming and markers (`src/provisioning/naming.ts`)

**Instance marker.** `settings.instance_id` holds 8 hex characters, generated by 07 at
setup. Every resource carries it, so two yaran control planes in one Cloudflare account
(for example staging and production) never adopt or delete each other's resources.

| Resource | Marker | Lookup |
|---|---|---|
| Tunnel | name `yaran-<inst>-<machine-uuid>` (charset `[a-z0-9-]`, 51 characters) | `GET cfd_tunnel?name=…&is_deleted=false` |
| Access policy | name `yaran:<inst>:owner:<machine-uuid>` | List (≤1000 per page, one call) and filter by name |
| Access app | name `yaran:<inst>:m:<machine-uuid>`, domain = hostname | `GET access/apps?domain=<host>&exact=true`, then check the name |
| DNS CNAME | comment `yaran:<inst>:m:<machine-uuid>` (53 characters, under the Free cap of 100) | `GET dns_records?type=CNAME&name=<host>` |

A resource whose marker belongs to another instance, or which has no marker, is **never**
modified or deleted. Finding one at our hostname is a hostname conflict (§3).

**Slugs:**

1. NFKD-normalize, then lowercase.
2. Drop combining marks.
3. Map every run of characters outside `[a-z0-9]` to a single `-`.
4. Trim `-` from both ends, then truncate.

- User slug: from the email local part, truncated to 20. If empty, `u` plus the first 6
  hex characters of SHA-256 of the email.
- `users.slug` is unique: a collision appends `-2` … `-99`, then `-<4 hex>`.
- Machine slug: from the claim's `machine_name`, which 02 already constrains to
  `MachineName` (`^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$`, ≤ 32; yaran slugifies before
  sending). The same function still runs over it, so a `--` in a valid `MachineName`
  collapses to `-`; at most 32 characters. If empty, `machine`.
- Because runs collapse to a single `-`, a slug can never contain `--`. That rules out
  IDNA `xn--` style labels and leading or trailing hyphens.

**Hostname:** `<machine-slug>-<user-slug>.<zone_name>`.

- It is one label: at most 32 + 1 + 20 + 3 for a suffix, which is 56, under 63.
  Universal SSL therefore covers it (D1, R4 §2.5).
- The candidate is refused, and the next suffix `-2`, `-3`, … tried, when it:
  - equals the control-plane host label;
  - is held in `machines.hostname` by a live row;
  - exists in DNS without our marker, or with another instance's marker;
  - exists as the domain of an Access app we do not own.
- **Re-pairing** the same machine name by the same user after its revoke reuses the
  released hostname. 06 decides whether a re-pair while the old machine is live revokes it
  first.

All four functions are pure, deterministic and property-tested.

### 3. Desired state (`src/cloudflare/desired.ts`)

These are pure builders taking `(machine, settings)` and returning request bodies, each
with a comparator that returns a list of drift reasons. Drift repair (§8) uses them too,
so "create" and "repair" cannot disagree.

**Policy:**

```json
{"name":"yaran:<inst>:owner:<id>","decision":"allow","include":[{"email":{"email":"<owner email>"}}]}
```

**App:**

```json
{
  "type": "self_hosted",
  "name": "yaran:<inst>:m:<id>",
  "domain": "<host>",
  "destinations": [{"type": "public", "uri": "<host>"}],
  "session_duration": "<Settings.session_duration>",
  "app_launcher_visible": false,
  "enable_binding_cookie": false,
  "http_only_cookie_attribute": true,
  "same_site_cookie_attribute": "lax",
  "options_preflight_bypass": false,
  "allow_iframe": false,
  "policies": [{"id": "<policy id>", "precedence": 1}]
}
```

- Binding cookie is off, per D2.
- `same_site` is `lax`, overridable by setting `machine_same_site` if G1 shows the injected
  cookie needs a different value.
- `/__yaran/handoff` deliberately has **no** public override: it must sit behind this app
  (D8).
- `session_duration` is 02's single `Settings.session_duration`, the same value 07 applies
  to the control-plane app.
- **G1 fallback L2 only** (Managed OAuth through the native loopback proxy, 03 G1): the
  builder adds `oauth_configuration {enabled: true, dynamic_client_registration: {enabled:
  true, allowed_uris: [...], allow_any_on_localhost: false, allow_any_on_loopback: false},
  grant: {access_token_lifetime: "15m", session_duration: <Settings.session_duration>}}`.
  `allowed_uris` holds the `https://<publisher-domain>/oauth/callback` URL on each origin of
  the Worker's `APP_CALLBACK_URLS`, plus `yaranapp://oauth/callback` for development builds
  (02 §10). Under the primary (L0) and L1 the field is absent. The comparator treats it as
  managed only when the builder emits it.

**Ingress** (the whole config, since PUT replaces it):

```json
{"config":{
  "ingress":[
    {"hostname":"<host>","service":"http://127.0.0.1:<origin_port>",
     "originRequest":{"access":{"required":true,"teamName":"<team name>","audTag":["<app aud>"]}}},
    {"service":"http_status:404"}],
  "originRequest":{}}}
```

- **Access is per route, never tunnel-level.** `originRequest.access {required, teamName,
  audTag}` sits inside the machine's own ingress rule; the top-level `originRequest` stays
  `{}`. G2 step 8 tests tunnel-level `access` and expects it **not** to enforce, so the
  design keeps per-rule access whatever that step records (R16).
- **cloudflared floor 2026.11.0.** Per-rule `access` is enforced only by cloudflared
  2026.11.0 or newer (G2's pinned floor). The Worker cannot see the connector's version,
  so the floor is enforced on the machine: Phase 10 pins cloudflared and refuses to start a
  binary older than 2026.11.0. yaran's own JWT check (D3, Phase 11) remains the second
  origin-side gate either way.
- The service is `127.0.0.1`, not `localhost`. yaran binds loopback IPv4 (README
  architecture diagram), and `localhost` can resolve to `::1` first (R4 §1.3,
  `noHappyEyeballs`). 03 G2's procedure and primary write `localhost:<port>`; the G2 run
  should use this builder's body so the proof covers the form that ships.
- `<origin_port>` is `machines.origin_port` read when P4 runs; P4 records the port it PUT
  in `machines.ingress_origin_port` (§7).
- No `httpHostHeader`, per D4. No timeouts are set, because their units in the API are
  UNVERIFIED (R4 §1.3), so cloudflared's defaults apply.
- `teamName` is the team label, the `auth_domain` without `.cloudflareaccess.com`. The
  `teamName` versus full-domain format is one of G2's pass criteria in 03, and the builder
  has one switch for either outcome.
- The trailing catch-all is always present.

**DNS:**

```json
{"type":"CNAME","name":"<host>","content":"<tunnel id>.cfargotunnel.com","proxied":true,"ttl":1,"comment":"yaran:<inst>:m:<id>"}
```

### 4. Saga engine (`src/provisioning/engine.ts`, `ops-store.ts`)

**One live op per machine.** `startOp` inserts a `provisioning_ops` row. If the partial
unique index `provisioning_ops_one_live` rejects it, `startOp` returns the existing live
op, and the caller says "already in progress" rather than starting a second.

**Lease.** `UPDATE … SET lease_owner = ?, lease_until = now + 60, state = 'running' WHERE id = ?
AND state IN ('pending','running','compensating') AND (lease_until IS NULL OR lease_until < now)`.
Exactly one driver wins (`meta.changes = 1`). Each step renews the lease in the same D1
`batch()` that records its result, so the recorded resource id, the op step advance and
the lease renewal are one transaction.

**Create-intent (crash safety without extra API calls).** Before any `POST` the engine
writes `params.intent.<step> = attempt`.

- A drive that finds an intent but no recorded id runs the **adopt lookup** by marker
  first. That one case covers "the POST succeeded, then we crashed before recording it".
- With no intent, the lookup is skipped. The normal path makes about 6 API calls instead
  of about 10.

**Drivers.** Three, all calling the same `driveOp(opId, budget)`:

1. **Inline** from the request that started the op (06's authorize confirm, or 07's admin
   action), with a budget of 15 s of wall time and 20 API calls.
2. **Drive-on-poll** from the progress endpoint 06 serves to the waiting browser page. It
   is rate-limited per user and only acquires a free lease.
3. **Cron** task `drive_ops`: up to 3 due ops per run.

There are no Queues and no Durable Objects. D1 leases give the serialization, and cron
gives liveness.

**Error policy:**

- `transient` and `rate_limited` errors return the op to `pending` with
  `next_attempt_at = now + backoff(attempt)`: 30 s, 2 min, 10 min, 30 min, then hourly.
  `max_attempts` is a setting, `provision_max_attempts`, default 24, which is about a day.
- `conflict` (unadoptable), `auth`, `invalid` and `quota` errors are permanent:
  - a `provision` op moves to `compensating`;
  - `teardown` and `rotate` ops move to `failed`, with an admin-visible
    `last_error_code`.
- Every state change writes an audit row (`provision.step`, `provision.failed`,
  `teardown.done`, and so on, from 02's `registry/audit-actions.json`) with the sanitized
  Cloudflare error.
- `getOp` maps op state to 02's `AdminMachine.provisioning.state` (`complete`,
  `in_progress`, `failed`, `compensating`) and its error to the wire code of §1.

### 5. Provision (`steps-provision.ts`)

The resources are created in this order on purpose: everything that protects the hostname
exists before the DNS record that publishes it. That satisfies the deploy-order warning
and D2's fail-closed rule.

| Step | Action | Idempotency |
|---|---|---|
| P0 `preflight` | Quota guard (§9); derive the hostname and check it is free (DNS `findByName`, apps `findByDomain`); persist `hostname` and `origin_port` (the pair request's `PairAuthorizeQuery.origin_port`, default 3890) | Re-derivation is deterministic; a persisted hostname is re-checked, not re-derived |
| P1 `policy` | Recorded id: `GET`. Missing: adopt by name, else `POST`. Record `access_policy_id` | Adopt-by-marker |
| P2 `app` | Same pattern with `policies:[{id, precedence:1}]`. Record `access_app_id` and `access_app_aud` | Adopt by domain plus name marker |
| P3 `tunnel` | `GET`, or adopt `?name=…&is_deleted=false`, else `POST {name, config_src:"cloudflare"}`. A 409 leads to adopt-by-name | Unique name |
| P4 `ingress` | `PUT configurations` with the desired ingress for the current `machines.origin_port`. Record `ingress_version` and `ingress_origin_port` | PUT is idempotent |
| P5 `dns` | `GET`, or adopt by name plus comment marker (PATCH `content` if the tunnel id differs), else `POST`. Record `dns_record_id` | Adopt-by-marker; a foreign record is a permanent `conflict` |
| P6 `finalize` | Guarded transition `provisioning → awaiting_claim` (06 moves it to `active` at claim) | Guarded `UPDATE` |

- **Compensation.** Permanent failure before P6 runs the teardown steps (§6) over whatever
  ids are recorded, sets `status = failed` and `revoke_reason = provision_failed`, and
  releases the hostname.
- **`repair`** runs P1–P5 against an existing machine without changing its status. Drift
  (§8) uses it when a resource vanished.
  - If P3 had to create a **new** tunnel, the old token is dead. The engine bumps
    `tunnel_secret_generation` (wire `token_version`); yaran sees the higher
    `tunnel.token_version` in its next signed W5 `GET /v1/machine/config` and calls W7
    `POST /v1/machine/rotate` with reason `sync`, which returns the new token through
    `fetchTunnelToken` (06, 10).

### 6. Teardown (`steps-teardown.ts`)

The caller first makes the guarded transition to `revoking` (wire `tearing_down`), in the
same D1 batch as `startOp`, and answers `202 TeardownStarted {machine_id, state:
"tearing_down"}`. From that moment every signed call from the machine gets
`410 machine_revoked` (04 §5), and yaran stops its leg out loud. Callers and the
`revoke_reason` each records:

| Caller | Route | `revoke_reason` |
|---|---|---|
| yaran `cloud logout` | W8 `POST /v1/machine/unpair` (06) | `machine_logout` |
| the owner in their console or app | W11 `DELETE /v1/me/machines/{id}` (06) | `user_unpair` |
| an admin | W21 `DELETE /v1/admin/machines/{id}` (07) | `admin_revoke` |
| an admin deleting or disabling a user | W19, W18 `AdminUserPatch {disabled: true, revoke_all: true}` (07) | `user_disabled` |
| the stale-machine policy | cron (07) | `stale` |
| provision compensation | §5 | `provision_failed` |

The order is D21's: DNS first, the tunnel next, the Access app and its policy last.

| Step | Action | "Already done" |
|---|---|---|
| T1 `dns` | Verify the marker, then `DELETE dns_records/{id}`. The hostname stops resolving to the tunnel **first** | 404 |
| T2 `invalidate` | `PATCH cfd_tunnel/{id} {tunnel_secret: <32 random bytes, base64>}`. The old token can no longer reconnect (first half of D21's "tunnel connections" stage) | 404: skip to T5 |
| T3 `connections` | `DELETE cfd_tunnel/{id}/connections` | 404 |
| T4 `tunnel` | `DELETE cfd_tunnel/{id}`. If refused while connections remain, wait 10 s and loop T3→T4 up to 5 times within the drive, then fall back to the transient backoff | 404 |
| T5 `app` | Verify the marker, then `DELETE access/apps/{id}` | 404 |
| T6 `policy` | `DELETE access/policies/{id}`, now detached because its only app is gone | 404 |
| T7 `finalize` | `status = revoked`; `hostname`, resource ids and AUD set to NULL; set `revoked_at`; audit `teardown.done` | Guarded `UPDATE` |

- `?cascade=true` is **not** used. It is undocumented in the API reference, and T2 plus T3
  already guarantee no live connector can reconnect.
- **Why this order (D21).** Deleting DNS first unpublishes the hostname before any
  protection is removed. Keeping the Access app and its policy until the tunnel is gone
  means that, at every instant of a teardown, anything still able to reach the origin
  meets Access; Cloudflare's deploy-order warning names the opposite state ("reachable by
  anyone"). The policy still has to follow the app, because a policy must be detached
  before deletion.
- If T4 still fails after the full backoff, the op ends `failed` with
  `tunnel_delete_blocked`. The admin console (07) offers a retry. The tunnel is already
  inert (no DNS, no valid token) and its Access app and policy are still in place, so
  nothing is exposed meanwhile; the cost is that the app and policy keep counting against
  the quota until the retry succeeds.

### 7. Rotation, token fetch, origin port (`steps-rotate.ts`, `index.ts`)

**`rotateTunnelSecret(machineId, {evict})`** is a `rotate` op driven inline. Its wire
callers are W7 `POST /v1/machine/rotate` with reason `user` (06) and W22
`POST /v1/admin/machines/{id}/rotate` (07), whose body `{kill_connections: bool}` maps to
`evict`:

1. `PATCH tunnel_secret`. Read `result.token`, falling back to `GET token`.
2. Increment `tunnel_secret_generation` (wire `token_version`).
3. If `evict` is set, also `DELETE connections`:
   - set for admin "compromised" rotations, so live connectors drop immediately;
   - unset for routine rotation, where old connectors stay until yaran restarts
     cloudflared with the new token (R4 §1.8).
4. Audit `machine.rotated`.

The token is returned to the inline caller as 02's `TunnelCredentials {id, token,
token_version}` and **never stored**. If the response is lost, yaran's next W5
`GET /v1/machine/config` carries the higher `tunnel.token_version`, and yaran calls W7 with
reason `sync`, which uses `fetchTunnelToken`.

**`fetchTunnelToken(machineId)`:**

- Calls `GET token` with `interactive` priority.
- Only for machines that are `awaiting_claim` or `active`.
- Callers (06: W4 claim, W7 `sync`) rate-limit it per machine.

**`setOriginPort(machineId, port)`** (R9). `[server] port` is configurable
(`config.rs:2242`), so the ingress target comes from the machine. Two callers:

- **W4 claim (06).** `ClaimRequest.origin_port` is required and authoritative. When it
  differs from the port provisioned at authorize (`PairAuthorizeQuery.origin_port`,
  default 3890), 06 calls `setOriginPort` before answering, and `ClaimResponse.origin_port`
  echoes the claimed port.
- **W32 `PUT /v1/machine/origin` (06 route, signed).** yaran sends `OriginUpdate
  {origin_port}` when its serving port changes (Phase 10 calls it before starting the leg,
  after comparing with `MachineConfig.origin_port`). The route answers
  `202 OriginUpdateResult {origin_port, changed}`.

Behaviour:

1. If `port` equals both `origin_port` and `ingress_origin_port`, nothing happens and the
   result is `changed: false`.
2. Otherwise one D1 batch persists `origin_port = port` and writes the audit row
   `machine.origin_changed` (old and new port in `detail`); the result is `changed: true`.
3. If no op is live for the machine, `startOp(repair, steps: [P4])` and drive it inline
   with a budget of 1 API call and 5 s. Whether or not the inline drive finishes, the
   route answers 202; `drive_ops` finishes it.
4. If an op is already live (a provision still running, a drift repair, a rotate), no
   second op is started. P4 always reads `machines.origin_port` when it runs and records
   the port it PUT in `ingress_origin_port`, and when any op finishes the engine compares
   the two and starts a P4-only `repair` if they differ. So a port change that lands
   mid-op is applied when that op ends, never lost. `cf_drift` (§8) checks the same pair
   as a backstop.
5. A machine being torn down never reaches this: its signed calls already get
   `410 machine_revoked`.

During the gap between the port change and the P4 PUT, cloudflared reaches the old port
and the browser sees a 502 from Cloudflare; nothing is exposed, because Access and the
in-tunnel check still stand in front.

### 8. Reconciliation (`src/reconcile/`)

There are four dispatcher tasks, registered in 04's `scheduled/tasks.ts`. Every one runs
at `background` priority, so when the budget runs low it yields to interactive work.

| Task | Interval | API calls per run | Work |
|---|---|---|---|
| `cf_status` | 60 s | 1 (≤1,000 tunnels means 1 page) | `GET cfd_tunnel?include_prefix=yaran-<inst>-&is_deleted=false&per_page=1000`; map by id; write `cf_status`, `cf_status_at`, `conns_active_at`, `conns_inactive_at` **only for changed rows**, chunked into one `batch()` of ≤100-parameter statements. A live machine whose tunnel is absent is marked `unknown` and its drift cursor is pulled forward |
| `cf_drift` | 5 min | ≤ 4 × `drift_machines_per_run` (default 5, so 20) | Cursor over active machines ordered by id. `GET` app, policy, config and DNS record; compare with `desired.ts` (the ingress comparison includes `origin_port` against the live service port); `PUT`/`PATCH` to repair; a missing resource starts a `repair` op. Each repair is audited (`drift.repaired`) with the drift reasons |
| `cf_orphans` | 60 min, one resource kind per run, rotating | 1 | One of: tunnels (reuses the `cf_status` list from D1 metadata, so 0 calls), DNS `comment.startswith=yaran:<inst>:m:`, apps (`per_page=1000`, name prefix), policies (`per_page=1000`, name prefix). Upsert candidates into `cf_orphans`, refresh the quota observation (§9), and delete rows no longer seen |
| `drive_ops` | 60 s | ≤ 20 | Drive up to 3 due ops (§4) |

**Orphans.** A marked resource whose machine row is missing, revoked or failed, or whose
id differs from the one recorded, is an orphan. It is deleted only when all hold:

- `seen_count ≥ 2`;
- `now − first_seen_at ≥ orphan_grace_minutes` (default 120);
- the machine has no live op.

Deletion runs in the D21 teardown order (DNS → tunnel invalidate, connections, delete →
app → policy) and each delete is audited as `orphan.deleted` (each candidate as
`orphan.found`).

- `Settings.orphan_cleanup` (02) is `delete` (default) or `report`. In `report` mode the admin
  console lists orphans and offers per-row deletion (07).
- Orphans need no op row, because they may belong to no machine. Every delete is
  idempotent (404 means done).

**Budget in steady state:**

- `cf_status` costs 5 calls per 5 min, `cf_drift` 20, and `cf_orphans` 0.25.
- Total: about 25 of 1,200 per 5 min (about 2%).
- A full drift cycle over 500 machines takes 100 runs, about 8 h. Changing
  `drift_machines_per_run` trades speed for budget, and 07 can reset the cursor after a
  settings change, for example a new session duration.

**Free-plan CPU and query limits:**

- Each run does one bounded slice.
- `cf_orphans` processes one resource kind per run.
- `cf_status` writes only changed rows in a single `batch()`, which is one query.
- The dispatcher's per-run caps (04 §11) are 40 D1 queries and 40 subrequests.

**Admin reconcile (W28 `POST /v1/admin/reconcile`, 202).** `requestReconcile` sets
`next_run_at = now` for `cf_status`, `cf_orphans` and `cf_drift` (whose cursor it resets),
audits `machine.reconciled` with target `org`, and returns at once; the tasks run on the
next cron tick under the usual budget and priority gate.

**On-demand freshness.** `refreshMachineStatus(machineId)` does one `GET cfd_tunnel/{id}`
when `cf_status_at` is older than 60 s, deduped by a conditional `UPDATE`. 06 calls it when
a single machine is opened, under its per-user limit.

### 9. Quota guard (`src/provisioning/quota.ts`)

- **Observation:** `{apps_total, policies_total, tunnels_total, observed_at}`, stored in
  the `cf_orphans` task's `scheduled_tasks.cursor` from `result_info.total_count`.
- **Freshness:** P0 uses an observation younger than 60 min. Otherwise it refreshes with 3
  `per_page=1` list calls.
- **Refusal:** if `total + 1 > Settings.quota_limits.<kind>` (`access_apps`,
  `access_policies`, `tunnels`), P0 fails permanently with `409 account_quota_reached`,
  `details: {resource, used, limit}`, and audits `quota.refused`. Defaults are 500 apps,
  500 policies, 1,000 tunnels; settings exist because Enterprise accounts can raise them.
  - The message names the quota and both numbers, and says how to raise it: request an
    increase, then update the setting in the admin console. All of the org's Access apps
    count, not only yaran's.
- **Warning:** the guard also warns, through an admin-console banner (07), at 90% of any
  quota.

### 10. Facade for 06 and 07 (`src/provisioning/index.ts`)

```ts
startProvision(ctx, machineId): Promise<OpRef>          // 06 at authorize confirm
startTeardown(ctx, machineId, reason): Promise<OpRef>   // W8, W11 (06); W19, W18 revoke_all, W21, stale (07)
startRepair(ctx, machineId): Promise<OpRef>             // 07 admin "repair"
rotateTunnelSecret(ctx, machineId, {evict}): Promise<TunnelCredentials>   // W7 user, W22 (kill_connections → evict)
fetchTunnelToken(ctx, machineId): Promise<TunnelCredentials>             // W4 claim, W7 sync
setOriginPort(ctx, machineId, port): Promise<{changed: boolean, op: OpRef | null}>   // W4, W32
requestReconcile(ctx): Promise<void>                     // W28
getOp(ctx, opId): Promise<OpView>                        // step, state, user-facing error code
driveOp(ctx, opId, budget): Promise<OpView>              // drive-on-poll
refreshMachineStatus(ctx, machineId): Promise<StatusView>
deriveUserSlug / deriveHostname                          // re-exported from naming.ts (04 identity uses deriveUserSlug)
```

### 11. Module tree (added to `cloud/worker/`)

Every code file is at most 500 lines and starts with the CONVENTIONS §2 header, checked
by `tools/module-headers --check`. Planned sizes are in brackets.

```text
cloud/worker/
├── scripts/record-cf-fixtures.mjs   manual recorder against a staging account; redacts ids/tokens/emails [~200]
├── src/cloudflare/
│   ├── client.ts        transport, timeout, envelope, in-call retries for idempotent verbs [~200]
│   ├── errors.ts        CfApiError + exhaustive classification table [~110]
│   ├── budget.ts        Ratelimit parse, cf_api_budget persistence, priority gate [~150]
│   ├── paginate.ts      page-based listAll with maxPages guard [~70]
│   ├── types.ts         minimal response subsets per endpoint [~180]
│   ├── tunnels.ts       tunnel endpoints [~200]
│   ├── dns.ts           DNS endpoints [~140]
│   ├── access.ts        Access app + policy endpoints [~230]
│   └── desired.ts       desired-state builders + drift comparators [~220]
├── src/provisioning/
│   ├── naming.ts        slugs, hostnames, markers, marker parsers [~170]
│   ├── quota.ts         observation + guard [~120]
│   ├── ops-store.ts     op insert, lease, step record (batched), finish [~210]
│   ├── engine.ts        driveOp loop, intent/adopt, backoff, compensation [~230]
│   ├── steps-provision.ts  P0–P6 [~270]
│   ├── steps-teardown.ts   T1–T7 [~230]
│   ├── steps-rotate.ts     rotate + origin port, port reconciliation after an op [~150]
│   └── index.ts         facade (§10) [~160]
├── src/reconcile/
│   ├── status.ts        cf_status task + refreshMachineStatus [~170]
│   ├── drift.ts         cf_drift task [~240]
│   ├── orphans.ts       cf_orphans task [~260]
│   └── tasks.ts         registration rows for 04's registry [~60]
└── test/
    ├── fake-cloudflare/
    │   ├── index.ts     msw handlers bound to api.cloudflare.com, call log [~130]
    │   ├── state.ts     in-memory account/zone state, id minting, limits [~160]
    │   ├── tunnels.ts   tunnel semantics incl. 409, connections, delete refusal [~220]
    │   ├── dns.ts       record semantics incl. same-name conflict [~160]
    │   ├── access.ts    apps/policies incl. 500 caps, detach-before-delete [~230]
    │   └── faults.ts    fault plans: fail Nth call, crash-after-success, 429 + headers, timeouts [~140]
    ├── fixtures/cfapi/  recorded/derived JSON per endpoint and case
    ├── client.test.ts  errors.test.ts  budget.test.ts  paginate.test.ts
    ├── naming.test.ts  desired.test.ts  quota.test.ts  ops-store.test.ts
    ├── provision.test.ts  teardown.test.ts  rotate.test.ts  origin-port.test.ts  crash-matrix.test.ts
    ├── status.test.ts  drift.test.ts  orphans.test.ts
    └── fixture-contract.test.ts   fake responses ⊇ recorded fixture shapes
```

**Fixtures.** The initial fixtures are derived from the `api-schemas` examples and the
tunnel tutorial's example responses (R4 §1.1), each tagged `"source": "derived"`.
`record-cf-fixtures.mjs` replaces them with `"source": "recorded"` captures from the
maintainer's staging account during 03/19. `fixture-contract.test.ts` then keeps the fake
honest against reality.

## Work items

1. **API client.**
   - Create `client.ts`, `errors.ts`, `budget.ts`, `paginate.ts` and `types.ts`.
   - Reuse 04's `security/secrets.ts` (token), `security/sanitize.ts`, `log/logger.ts`
     and `db/client.ts`.
   - Tests:
     - envelope parsing (success, `success:false`, non-JSON 5xx);
     - each classification row;
     - idempotent verbs retry and `POST`/`PATCH` do not;
     - the timeout aborts;
     - `Ratelimit` parsing, including malformed or absent headers;
     - the priority gate (`background` refused under reserve, `interactive` allowed);
     - `blocked_until` short-circuits with no network call;
     - the token never appears in a thrown error or log (sentinel check, reusing 04's
       capture);
     - Phase 19 hook H3: requests go to `CF_API_BASE_URL` when set and to
       `https://api.cloudflare.com/client/v4` when unset; a non-`https:` value is refused.

2. **Endpoint modules.**
   - Create `tunnels.ts`, `dns.ts` and `access.ts`.
   - Tests against the fake: one per function, including:
     - the `token` present/absent fallback for create and rotate;
     - `connections` absent versus `[]`;
     - app list with `domain` + `exact`;
     - policy list paging.

3. **Naming and desired state.**
   - Create `naming.ts` and `desired.ts`.
   - Tests:
     - property tests over random Unicode emails and machine names: every hostname is a
       valid one-label RFC 1123 name of at most 63 characters, contains no `--`, and is
       deterministic;
     - collision suffix sequence;
     - marker round trip (build, then parse);
     - another instance's marker is rejected;
     - golden JSON for every builder;
     - each comparator detects each single-field drift and ignores server-added fields
       (`id`, `created_at`, `aud`, `version`).

4. **Saga engine and ops store.**
   - Create `ops-store.ts` and `engine.ts`.
   - Tests:
     - one live op per machine (a second start returns the first);
     - lease exclusivity between two concurrent drivers;
     - a lease expiry lets another driver resume;
     - the backoff schedule;
     - `max_attempts` reaches `failed`;
     - the audit row per transition.

5. **Provision, teardown, rotate.**
   - Create `steps-provision.ts`, `steps-teardown.ts`, `steps-rotate.ts` and `index.ts`.
   - Tests:
     - the happy paths;
     - the fake's call log proves the D21 order. Provision: policy, app, tunnel, config,
       DNS. Teardown: DNS, invalidate, connections, tunnel, app, policy. **No call log ever
       contains a DNS record pointing at a tunnel while its Access app is absent**, and no
       tunnel ever exists without its Access app during a teardown (invariants checked
       after every call);
     - the ingress body puts `originRequest.access` inside the machine's rule and leaves
       the top-level `originRequest` empty (golden test);
     - each teardown caller records its `revoke_reason` and answers `TeardownStarted`;
     - foreign DNS record gives a permanent conflict, then compensation, then `failed`
       with the hostname released;
     - quota refusal;
     - tunnel delete refused, then the T3/T4 loop, then success;
     - `evict` behaviour, and W22's `kill_connections` maps to it;
     - the token is never written to D1 (scan every table after each test).
   - `origin-port.test.ts`:
     - same port gives `changed: false` and no API call;
     - a new port persists, audits `machine.origin_changed`, re-PUTs only the ingress with
       the new service port and records `ingress_origin_port`;
     - a port change while a drift repair or rotate op is live starts no second op and is
       applied by a P4-only repair when that op finishes;
     - a claim whose `origin_port` differs from the authorize port ends with the ingress on
       the claimed port;
     - `cf_drift` repairs an `origin_port`/`ingress_origin_port` mismatch left by a crash.

6. **Crash matrix.**
   - `crash-matrix.test.ts` runs, for every step × each fault in
     {transient before the call, crash after success before recording, 429 with
     `retry-after`, permanent 4xx}:
     1. drive;
     2. inject the fault;
     3. re-drive until terminal.
   - It asserts exactly one resource of each kind exists (or none after
     compensation/teardown), that recorded ids match the fake, and that no resource of
     another instance was touched.
   - Teardown is run twice to prove idempotence.

7. **Reconciliation.**
   - Create `status.ts`, `drift.ts`, `orphans.ts` and `tasks.ts`.
   - Tests via 04's dispatcher and `createScheduledController`:
     - status writes only changed rows and stays within one batch;
     - a missing tunnel becomes `unknown` and pulls the drift cursor forward;
     - drift per resource type is repaired and audited;
     - a vanished resource starts a `repair` op, and a new tunnel bumps the generation;
     - orphans respect the grace and `seen_count`, and `report` mode deletes nothing;
     - another instance's and unmarked resources are untouched;
     - with the budget under the reserve, every reconcile task skips and records why;
     - per-run subrequest and query counts stay ≤ 40 (asserted from the fake's call log
       and a D1 query counter);
     - Phase 19 hook H5 (05's half): `requestReconcile` (W28) sets `next_run_at = now` for
       the three tasks, resets the drift cursor, audits `machine.reconciled` and makes no
       Cloudflare call itself; a provision past `quota_limits.access_apps` set below 500
       is refused with `account_quota_reached` (the soft cap).

8. **Fixtures and recorder.**
   - Create `scripts/record-cf-fixtures.mjs`, `test/fixtures/cfapi/*` and
     `fixture-contract.test.ts`.
   - The recorder runs only with explicit `CF_STAGING_*` environment variables, refuses
     any account not marked as staging, and redacts ids, tokens and emails.
   - Tests: the redaction function on a sample capture; the contract test compares the
     fake against every fixture.

9. **Registry and settings wiring.**
   - Use the dotted actions already in 02's `registry/audit-actions.json` (04 generates its
     union from it): `provision.step`, `provision.done`, `provision.failed`,
     `teardown.step`, `teardown.done`, `teardown.failed`, `machine.rotated`,
     `machine.origin_changed`, `machine.reconciled`, `drift.repaired`, `orphan.found`,
     `orphan.deleted`, `quota.refused`, `cloudflare.rate_limited`.
   - Add the Worker-internal settings rows (no admin API, 02 §6 note) to 04's
     `db/settings.ts`, with defaults and validators: `api_background_reserve`,
     `drift_machines_per_run`, `provision_max_attempts`, `machine_same_site`. The contract
     settings this phase reads (`session_duration`, `quota_limits`, `orphan_cleanup`) are
     02's `Settings` keys, stored by 04 and written by 07.
   - The error codes this phase surfaces are all in 02's registry already:
     `account_quota_reached`, `hostname_conflict`, `provisioning_in_progress`,
     `provisioning_failed`, `cloudflare_rate_limited`, `cloudflare_unavailable`,
     `cloudflare_permission_denied`, `cloudflare_api_failed`, `tunnel_delete_blocked`.
   - Tests: the settings validators, and that each action and code this phase emits is in
     its registry (failing on any name the registry lacks).

10. **Threat-model rows.**
    - Mitigation text for these IDs from Phase 17's allocation (T25–T64):
      - **T31**, **T47** control-plane `CF_API_TOKEN` theft, and its blast radius per
        permission (no Workers Scripts, no token minting);
      - **T56** cross-instance resource confusion, mitigated by the instance marker, and
        orphan deletion of a foreign resource, mitigated by marker, grace and two sightings;
      - **T25** publish-before-protect: the D21 order, per-route `originRequest.access`,
        the cloudflared 2026.11.0 floor enforced by Phase 10;
      - **T45** teardown leaving a live connector, mitigated by invalidate (T2) and
        connection deletion (T3) before the tunnel is deleted;
      - **T27** tunnel tokens never stored in D1, delivered only to the signed caller;
      - **T28** signed origin-port changes (W32) and rotations (W7) only after 04's
        signature checks;
      - **T49** Cloudflare API budget and the 500-app/500-policy/1,000-tunnel quotas;
      - **T53** Cloudflare error text sanitized before logs and audit;
      - **T32**, **T55** no same-zone fetch to machine hosts, and nothing secret in the op
        rows (`params`, `last_error`).

## Acceptance

- [ ] Provision creates, in order, policy → app → tunnel → ingress → DNS. A test invariant proves that no DNS record ever points at a tunnel whose Access app is absent.
- [ ] Every crash-matrix cell converges to exactly one resource of each kind, or to none after compensation or teardown, with no duplicates and no foreign resource touched.
- [ ] Teardown runs in the D21 order (DNS → invalidate → connections → tunnel → app → policy), is idempotent, invalidates the tunnel secret before deleting connections, and never uses undocumented `cascade`.
- [ ] Every ingress rule carries its own `originRequest.access {required, teamName, audTag}`; the tunnel-level `originRequest` never carries `access`.
- [ ] An origin-port change from W4 or W32 reaches the ingress, also when it lands during another live op; `OriginUpdateResult.changed` is false only when nothing changed.
- [ ] Every error code and audit action this phase emits is in 02's registries.
- [ ] Tunnel tokens are never persisted. A full-table scan after every test finds none.
- [ ] At most one live op per machine; concurrent drivers never both hold the lease.
- [ ] The rate-limit budget is honored: `blocked_until` is never violated, and background tasks yield under the reserve. Steady-state reconcile uses ≤ 30 calls per 5 min for any org size up to the account quotas.
- [ ] The status cache updates within 60 s of a tunnel state change and writes only changed rows.
- [ ] Drift on any managed field is repaired and audited. A vanished resource is recreated via `repair`.
- [ ] Orphans are deleted only after grace and two sightings, only with this instance's marker, and never in `report` mode.
- [ ] The quota guard refuses with a message naming the quota and how to raise it, and warns at 90%.
- [ ] Every cron run stays within 40 D1 queries and 40 subrequests.
- [ ] Every code file is at most 500 lines and its module-header block passes `tools/module-headers --check`.

## Validation

```bash
cd cloud/worker
npm ci
npm run types:check
npm run typecheck
npm run lint
npm test -- --reporter=verbose test/crash-matrix.test.ts test/provision.test.ts test/teardown.test.ts test/origin-port.test.ts
npm test                                   # full suite, includes 04's authz matrix and leak test
npm run build                              # wrangler deploy --dry-run
cd ../.. && node tools/module-headers/bin/module-headers.mjs --check cloud/worker   # Phase 01 CLI
# Staging only, maintainer-run (03/19): refresh recorded fixtures, then re-run the contract test
# CF_STAGING_ACCOUNT_ID=… CF_STAGING_ZONE_ID=… CF_STAGING_TOKEN=… node cloud/worker/scripts/record-cf-fixtures.mjs
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `token` absent from create or rotate responses (schema omits it) | Medium | Extra call | The client always falls back to `GET …/token`; both paths are tested |
| DNS conflict error codes differ from the third-party list | Medium | Conflict misclassified as `invalid` | P0 pre-checks by name, so a conflict is rarely reached at P5; classification matches the `8105x` range and the message; a recorded fixture pins the real code in 19 |
| Server rejects deleting a still-attached policy with an unknown error | Low | Teardown stalls at T6 | T5 always precedes T6; a T6 failure re-reads `app_count` and re-runs T5 if non-zero |
| Tunnel delete keeps failing while a rogue connector reconnects | Low | Op fails `tunnel_delete_blocked`; app and policy stay until retry | T2 invalidates the token first, so it cannot reconnect; the loop is bounded; the tunnel is inert and still behind Access; admin retry in 07 |
| A machine runs cloudflared older than 2026.11.0, which may not enforce per-route `access` | Low | The in-tunnel Access check is missing | Phase 10 refuses to start a binary below the floor; yaran's own JWT check (D3, Phase 11) still gates every request on the cloud host (T25) |
| `teamName` format (label vs full domain) wrong in `originRequest.access` | Medium | cloudflared rejects every request (fail closed, never open) | One switch in `desired.ts`, decided by G2 in 03 |
| Ingress timeout units unknown | Low | None (unset) | Defaults used; no timeouts sent |
| Free-plan 10 ms CPU exceeded parsing a 1,000-tunnel list | Low | Cron run aborted, status stale | Writes only changed rows; Phase 19 measures CPU with Workers Logs; docs recommend Paid above ~300 machines |
| Shared 1,200/5 min budget with other uses of the same token | Low | 429 blocks everything for 5 min | Dedicated token documented by 07; the priority gate and `blocked_until` stop the Worker making it worse; interactive errors carry `Retry-After` |
| A second yaran deployment in the same account | Medium | Cross-deletion | Instance marker on every resource; orphans and adoption filter on it; tested |
| Dashboard edits to a managed app or policy get reverted by drift repair | Medium | Admin surprise | Repairs are audited with reasons; docs (17) state that yaran-managed resources are owned by the Worker; `drift_machines_per_run = 0` disables repair |
| Port change lost to an op that already passed P4 | Low | Ingress targets the old port; the machine shows 502 | `ingress_origin_port` is compared with `origin_port` whenever an op finishes and by `cf_drift`; `origin-port.test.ts` covers it |

## References

- `docs/plans/phoneapp/00-README.md` (D1, D2, D4, D5, D6, D16, D21; flows 2, 6)
- `docs/plans/phoneapp/02-protocol-contract.md` §4 (codes), §5 (W4, W5, W7, W8, W11, W21, W22, W28, W32), §6 (`ClaimRequest`, `OriginUpdate`, `Settings`, `AdminMachine`, audit actions)
- `docs/plans/phoneapp/03-platform-verification-gates.md` G1 (fallback L2), G2
- `docs/plans/phoneapp/04-worker-foundation-and-security.md` (§5, §7, §11, §12)
- `docs/plans/phoneapp/research/R4-cloudflare.md`: Part 1 §1.1–2.5, Part 2 §1–2, Part 4 §3, Part 5 §3, §5–6, §9; Hard constraints 1–3
- `docs/plans/phoneapp/research/R1-server-core-cli.md:238` (Host-rewrite consequence)
- `crates/yaran-core/src/config.rs:883`, `:2242` (`[server] port`, default 3890)
- https://github.com/cloudflare/api-schemas `openapi.json` (commit 2026-11-13)
- https://github.com/cloudflare/cloudflared/blob/master/cfapi/tunnel.go (`cascade`, name conflict)
- https://developers.cloudflare.com/changelog/post/2026-07-09-tunnel-routes-and-connections-api-changes/ (2026-07-09)
- https://developers.cloudflare.com/fundamentals/api/reference/limits/ (2026-08-25)
- https://developers.cloudflare.com/dns/manage-dns-records/reference/record-attributes/ (2026-08-14)
- https://developers.cloudflare.com/dns/manage-dns-records/troubleshooting/records-with-same-name/ (2026-07-20)
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/policy-management/ (2026-11-02)
- https://developers.cloudflare.com/cloudflare-one/account-limits/ (2026-11-05)
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/ (2026-04-17)
- https://developers.cloudflare.com/workers/platform/limits/ (2026-11-13)
- https://developers.cloudflare.com/d1/platform/limits/ (2026-10-30)

## Reconciliation notes (2026-11-14)

- R7/D21: teardown reordered to DNS → invalidate → connections → tunnel → Access app → policy (steps T1–T7 renumbered), the "Conflict with README flow 6" block replaced by the D21 rationale; orphan deletion order, call-log tests, acceptance and risk rows updated; provision order (policy → app → tunnel → ingress → DNS) unchanged and now cites D21.
- R16: ingress states per-route `originRequest.access` (tunnel-level never used, G2 step 8) and the cloudflared 2026.11.0 floor enforced by Phase 10; golden test, acceptance and risk row added; noted that 03 G2 writes `localhost` while this builder uses `127.0.0.1`.
- R9: `setOriginPort` designed for W4 (authoritative `ClaimRequest.origin_port`) and W32 `PUT /v1/machine/origin` (`OriginUpdateResult.changed`), with `ingress_origin_port` (new 04 column) so a change during a live op is applied when that op ends; `origin-port.test.ts` added; the "cross-phase requirement for 02/06" block removed (02 now defines it).
- R8: teardown callers mapped to W8 `POST /v1/machine/unpair`, W11, W18/W19, W21 with their `revoke_reason`; answers `TeardownStarted`.
- Canonical names: `quota_exceeded` → `account_quota_reached` (`details {resource, used, limit}`); audit actions dotted (`provision.step` …, `machine.rotated`, `quota.refused`, `cloudflare.rate_limited`, plus `machine.origin_changed`, `machine.reconciled`); `machine_session_duration` → `Settings.session_duration`; `quota_limits` → `{access_apps, access_policies, tunnels}`; `orphan_cleanup` cited as a `Settings` key; internal knobs marked Worker-internal (02 §6 note).
- Canonical names: `tunnel_secret_generation` maps to wire `token_version`; W22 `{kill_connections}` maps to `evict`; token delivery via `TunnelCredentials`; "next GET config" → W5 plus W7 `sync`.
- 02 §4: CfApiError kinds mapped to registry codes (`cloudflare_rate_limited`, `cloudflare_unavailable`, `hostname_conflict`, `cloudflare_permission_denied`, `cloudflare_api_failed`, `provisioning_failed`); the work item now uses existing registry names instead of adding codes.
- 02 W28 (owned by 05, previously missing): `requestReconcile` added to the facade.
- 02 `MachineName` (≤ 32): machine slug length and hostname bound (56) updated.
- G1 (R20): fallback-L2 `oauth_configuration` with `allowed_uris` from `APP_CALLBACK_URLS` origins (`/oauth/callback`) plus the dev custom scheme.
- R4: `npm run protocol:check` removed from Validation.
- R14: threat-model work item now cites T31, T47, T56, T25, T45, T27, T28, T49, T53, T32, T55.
- R20: Depends on adds 03 (G1, G2).

### Straggler pass (2026-11-14)

- Straggler pass: Phase 19 hook H3 implemented: the client's base URL comes from the Worker var `CF_API_BASE_URL` (default `https://api.cloudflare.com/client/v4`, `https:` only), with a work-item 1 test (R15).
- Straggler pass: work item 7 gains the H5 test for 05's half (`requestReconcile` W28 and the `quota_limits.access_apps` soft cap) (R15).
- Straggler pass: D21 teardown order verified everywhere in 05 (§6 table, orphans, tests, acceptance); no edit. The earlier note that 03 G2 writes `localhost` is resolved: G2 uses `127.0.0.1` (R7, R16).
- Straggler pass: module-header command comment aligned to 01's CLI (`node tools/module-headers/bin/module-headers.mjs`) (R20).
- D24 (final pass): threat range reference T25–T63 → T25–T64 (17 appended T64, remembered-consent bypass).
