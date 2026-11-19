# Phase 07 — Org Worker: Deploy button, setup wizard, admin and user console, updates

**Track:** B (org control plane) · **Parallel-safe with:** 04–06, 08–18 (codes against 02 and mocks of 04/05/06)
**Depends on:** 02; code-level 04, 05, 06 and 14 (`packages/ui-kit` tokens, R18); gates G8, G9, G10, G11, G14 (primary and fallback both specified) · **Blocks:** 06 (work item 1, the UI kit), 17 (admin docs, screenshots), 18 (release-cloud runs the deploy-tree assembler), 19

## Goal

Make "an admin clicks **Deploy to Cloudflare**, supplies the three deploy-time secrets
(`CF_API_TOKEN` from a pre-scoped template link, `SETUP_CODE`, `DATA_KEY`; D20), opens the
setup page, and has a working org control plane on their own domain" true. Then give
admins and users the consoles to run it:

1. A **self-contained deploy tree**, published by the `yaran-cloud-v*` release workflow as
   the generated `cloud-deploy` branch (D18), and the README **Deploy to Cloudflare**
   button pointing at it, with `package.json` binding descriptions, `.dev.vars.example`
   secrets, and a deploy script that applies D1 migrations.
2. An **account-owned API token template** link keyed by permission group IDs. Every
   permission is least privilege and documented.
3. A **setup wizard** that does everything else by code:
   - checks the setup code and verifies the token's capabilities;
   - selects the zone, creates the control-plane Access app and its public overrides, and
     attaches the custom domain by API, then disables `workers.dev` by API (D19);
   - checks identity providers and offers One-time PIN, GitHub or Google;
   - generates the VAPID key;
   - bootstraps the admin through a real SSO round trip;
   - closes setup for good.
4. An **admin console** (users, machines, devices, audit log, settings, health, quotas,
   updates) and a **user console** (my machines, my phones, phone QR, connect a machine).
   Every destructive action asks for confirmation.
5. An **update checker** for the `yaran-cloud-v*` train and a documented, verified
   **update procedure** for the deployer's cloned repo, automated as a workflow that
   opens a pull request.

## Evidence

- **Deploy button** (https://developers.cloudflare.com/workers/platform/deploy-buttons/,
  updated 2026-10-12):
  - The URL form is `https://deploy.workers.cloudflare.com/?url=<repo>`, with an optional
    `/tree/<branch>/<path>` subdirectory.
  - The app must be "fully isolated within that subdirectory, including any dependencies".
  - The subdirectory "is treated as the root of the new repository".
  - Only public github.com and gitlab.com repos work.
  - The button reads the Wrangler config and provisions D1.
  - Secrets come from `.dev.vars.example`. Binding descriptions go in `package.json` →
    `cloudflare.bindings.<NAME>.description`, with inline markdown and links.
  - The `build`/`deploy` scripts are pre-filled.
  - **D1 migrations are not applied automatically**, so they go in the `deploy` script
    (`wrangler d1 migrations apply <BINDING> --remote`).
  - (`research/cloudflare-parts/04-token-deploy.md` §4–6.)
  - **UNVERIFIED:** whether a secret can be left blank; whether git history is kept;
    whether `workers_dev` is honoured; whether a branch-root URL works.
  - **Consequence:** on `main` the Worker imports `cloud/protocol` as a workspace package
    and reads its theme tokens from `packages/ui-kit/` (R18), so `cloud/worker/` on `main`
    is *not* self-contained, and no vendored copy lives on `main` (D18, R4). This phase
    therefore supplies the assembler that the release workflow runs to publish a
    self-contained tree on the `cloud-deploy` branch, with both bundled in (work item 2).
- **Upstream updates:** the deployer gets a clone with no documented upstream sync (UNVERIFIED
  as an official statement, `04-token-deploy.md` §6; `R4-cloudflare.md:1256`), so an
  update path has to ship with the tree.
- **Token template** (https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/,
  updated 2026-09-21):
  - The account-owned form is
    `https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=<urlencoded JSON>&name=<name>`.
  - A `key` may be a 32-hex permission group ID, "the most reliable option". Unresolvable
    entries show a notice instead of being dropped silently.
  - Zone scoping happens in the form.
  - Most IDs come from an unofficial datamine and must be re-resolved through
    `GET /accounts/{id}/tokens/permission_groups` (G9; `04-token-deploy.md` §2).
- **Cloudflare API endpoints** (Cloudflare API reference, checked 2026-11-14; permission
  lists are "at least one required"):
  - Custom domain: `PUT /accounts/{id}/workers/domains` with `{hostname, service, zone_id}`
    needs **Workers Scripts Write**.
  - workers.dev off: `POST /accounts/{id}/workers/scripts/{name}/subdomain {enabled:false}`
    needs Workers Scripts Write.
  - Access app: `POST /accounts/{id}/access/apps` needs **Access: Apps and Policies Write**.
    Self-hosted `destinations[]` of type `public` accept
    `overrides: [{behavior:"public", path_pattern}]`. A pattern does not cover subpaths,
    and at most one `*` is allowed per segment. `result.aud` is the AUD tag.
  - Reusable policy: `POST /accounts/{id}/access/policies {name, decision, include, …}`.
  - IdPs: `GET`/`POST /accounts/{id}/access/identity_providers`. One-time PIN is
    `{name, type:"onetimepin", config:{}}` and needs **Access: Organizations, Identity
    Providers, and Groups Write**.
  - Team domain: `GET /accounts/{id}/access/organizations` returns `result.auth_domain`. A
    `POST` to create an organization exists, but every field is optional and the page
    states no plan requirement.
  - Token verify: `GET /accounts/{id}/tokens/verify` (it needs the account id).
    `GET /accounts` (account discovery) lists no permissions. **UNVERIFIED** for
    account-owned tokens.
- **Zero Trust onboarding** needs a payment method even on the Free plan (50 seats)
  (https://developers.cloudflare.com/cloudflare-one/setup/, updated 2026-10-12;
  `02-access.md:157-159`).
  - **UNVERIFIED:** whether a brand-new account can skip that via the organizations `POST`.
  - New orgs default to the Cloudflare-account IdP ("restrict to account members"), and
    One-time PIN is no longer added automatically (`02-access.md:152`). That's why the
    wizard checks IdPs (R4 Hard constraint 4, `R4-cloudflare.md:1238`).
- **Publishing order matters:** a tunnel route published before its Access app is public
  (`02-access.md:96`). The wizard applies the same rule to the control-plane hostname:
  Access app first, custom domain second.
- **workers.dev and previews** (https://developers.cloudflare.com/workers/configuration/routing/workers-dev/,
  updated 2026-11-06; `05-workers.md` §1.4–1.5):
  - A dashboard toggle is undone by the next Wrangler deploy unless the config says
    `workers_dev = false`. This is why the shipped tree keeps `workers_dev: true` (D19,
    R5: setup needs the workers.dev host), the wizard disables workers.dev by API at close,
    and the update workflow later rewrites the deployer's config to `false` (§2).
  - Disabling workers.dev doesn't disable preview URLs.
  - Preview URLs are public unless Access protects them.
- **No runtime self-name:** the version-metadata binding gives only `id`, `tag` and
  `timestamp`
  (https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/,
  updated 2026-07-03).
- **GitHub releases API:** 60 unauthenticated requests per hour per IP, and unauthenticated
  304s still count (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api;
  …/best-practices-for-using-the-rest-api, checked 2026-11-14). Worker egress IPs are
  shared, so the API can only be a fallback. `/releases/latest` is repo-wide, so a
  `yaran-cloud-v*` check must not use it (`R3-repo-process.md:99`).
- **Console UI research** (checked 2026-11-14):
  - `hono` 4.13.18 is MIT with zero runtime dependencies. `hono/jsx` renders to a string
    without the router and escapes children and attributes; only `raw()` and
    `dangerouslySetInnerHTML` bypass that (source read: `src/jsx/base.ts`).
  - `hono/csrf` checks `Origin`/`Sec-Fetch-Site` on unsafe form posts and does *not*
    check JSON.
  - `secureHeaders` sets HSTS, nosniff, frame and referrer policy, and a configurable CSP
    (https://hono.dev/docs/middleware/builtin/csrf, …/secure-headers).
  - Workers Static Assets is GA, and a `_headers` file applies to assets only
    (https://developers.cloudflare.com/workers/static-assets/headers/).
  - `<dialog>.showModal()` has been Baseline since 2022: the background goes inert, Esc
    closes it, and it sets `aria-modal`. Inline handlers are blocked by `script-src 'self'`
    (MDN `dialog`).
  - WebCrypto ECDSA P-256 `generateKey` and `exportKey` (`raw` and `jwk`) are supported in
    workerd (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/; workerd
    `src/workerd/api/crypto/ec.c++`).
- **Repo theme to share:**
  - shadcn tokens: today the light set is in `crates/yaran-web/web/src/index.css:333-383`
    and the `.dark` set starts at `:385`. Phase 14 moves them (with `:98-201`) into
    `packages/ui-kit/src/tokens.css`, the one shared token source for the web UI, the app
    shell and this console (R18).
  - Tailwind v4 is CSS-first, with `@theme inline` at `index.css:100-201`. A browser drops
    `@theme` and other unknown at-rules, so the plain custom properties in `tokens.css`
    are usable by a stylesheet that has no Tailwind build.
  - The UI is dark-only in practice (`crates/yaran-web/web/src/main.tsx:8-9`).
  - Fonts are self-hosted (`@fontsource-variable/geist`, `index.css:4`;
    `package.json:18`).
  - Names in prose render as `InlineCode`
    (`crates/yaran-web/web/src/components/ui/inline-code.tsx:11-22`).
- **Release plumbing:**
  - `release.yml` accepts only `yaran-v*` / `dux-amq-v*` (`.github/workflows/release.yml:56-70`),
    so it must not be extended (D15).
  - Provenance attestations already exist (`release.yml:257`).
  - Tag protection is documented at `.github/BRANCH_PROTECTION.md:44-45`.

## In scope

The deploy tree and its assembler, the button, binding descriptions, the secrets example,
the deploy and build scripts, the token template generator and its permission manifest,
the setup wizard, the console UI kit, the admin and user consoles, the admin JSON API
(`/v1/admin/*`), settings and their side effects, the stale-machine policy verdict, audit
retention, the update checker, the release manifest schema, the in-tree update workflow,
and the deployed repo's README.

## Out of scope

- Router, JWT middleware, roles, signature verification, D1 baseline, audit writer, rate
  limits, at-rest sealing (`DATA_KEY`): **04**.
- Cloudflare API client, machine provisioning, teardown, rotation, reconciliation cron,
  quota accounting: **05**. This phase calls 05's client for its own Cloudflare writes and
  adds those operations to it.
- Pairing, handoff, device registry, machine view model, QR payload: **06**. The consoles
  reuse them.
- Web Push sending: **08**. This phase only generates and stores the VAPID key and the
  push on/off setting.
- `release-cloud` workflow, tag protection change, SHA-pinned action policy: **18**. This
  phase supplies the assembler, manifest and checks that 18 runs.
- Consumer docs pages (admin setup, update guide), the threat-model entries for the setup
  window and the consoles (T31, T33, T41, T47, T52, T54), and screenshots: **17**. This
  phase supplies the facts and the in-tree README.
- The shared token source `packages/ui-kit/` and its native colour export: **14**. This
  phase consumes `tokens.css` and generates no colours of its own.

## Design

### 1. Deploy tree and button

`main` keeps the developer layout: `cloud/worker` imports `cloud/protocol` as a workspace
package and the console's tokens come from `packages/ui-kit/` (no vendored copy and no
generated theme on `main`; D18, R4, R18). `cloud/worker/scripts/assemble-deploy-tree.ts`
builds a **self-contained** tree with both bundled in:

```text
<out>/worker/                     becomes the root of the deployer's repository
├── package.json                  cloud/protocol bundled as "file:vendor/cloud-protocol"; scripts below
├── package-lock.json             regenerated against the bundled path
├── wrangler.jsonc                bindings without IDs (auto-provisioned), workers_dev true, preview_urls false,
│                                 no routes and no custom domain (D19), vars APP_CALLBACK_URLS and CF_API_BASE_URL (commented)
├── .dev.vars.example             CF_API_TOKEN, SETUP_CODE, DATA_KEY (D20), each with a comment
├── release.json                  this tree's release manifest (schema in cloud/protocol)
├── README.md                     deployer-facing: what it is, first-run, updating, recovery
├── src/ migrations/ assets/      copied from cloud/worker; assets/console/tokens.css copied from packages/ui-kit
├── vendor/cloud-protocol/        built protocol package (JS + .d.ts + schemas), bundled only on this branch
├── scripts/update/               fetch-release.ts, apply-update.ts, merge-wrangler.ts
├── .github/workflows/yaran-cloud-update.yml
└── .gitlab-ci.yml                same update job for GitLab deployers
```

`release-cloud.yml` (Phase 18) runs the assembler for every `yaran-cloud-vX.Y.Z` tag. It
pushes the result to the generated branch **`cloud-deploy`** of `SiavZ/yaran` (R4; never
edited by hand; release candidates go to `cloud-deploy-rc` instead, for 19's staging runs,
18 Cloud release step 3), with the tree under `worker/`, and attaches
`yaran-cloud-worker-vX.Y.Z.tar.gz` plus its `.sha256` and a provenance attestation to the GitHub release. The README badge uses the documented
subdirectory form:

```markdown
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/SiavZ/yaran/tree/cloud-deploy/worker)
```

This stays inside the canonical repository (no invented repo or package, D16) and meets
the isolation rule. G11 proves the button against this exact URL: deploy, D1 provisioning,
migrations in the deploy script, and the secret prompts. **Fallback if G11 shows the
subdirectory form fails:** the assembler also emits the tree at the root of a second
branch, `cloud-deploy-root`, and the badge switches to
`/tree/cloud-deploy-root`. The tree contents are the same, so nothing else changes.

`package.json` scripts in the tree:

```json
"build": "tsc -p tsconfig.assets.json",
"deploy": "npm run db:migrations:apply && wrangler deploy",
"db:migrations:apply": "wrangler d1 migrations apply DB --remote"
```

The `build` step compiles `assets/console/enhance.ts`, the only script the console
loads. Migrations follow the repo's additive schema policy
(`docs/contributing/schema-policy.md`): additive only, so the old Worker keeps working in
the window between applying the migration and switching to the new code.

Binding descriptions (`cloudflare.bindings`):

- `CF_API_TOKEN` links the token template URL and says "create it first; you can also
  paste it in the setup page".
- `SETUP_CODE` says "at least 24 random characters, e.g. `openssl rand -base64 24`; you will
  type it once".
- `DATA_KEY` says "at least 32 random bytes, e.g. `openssl rand -hex 32`; it encrypts the
  secrets the Worker generates and stores (VAPID private key, device endpoints); keep a
  copy, a lost key means re-running key generation and phone re-registration" (04 owns the
  format check).
- `DB` says "created for you".
- `APP_CALLBACK_URLS` (a `vars` entry, not a secret) carries an inline comment: the https
  app callbacks the handoff may redirect to (02 §8), set by the release build from the
  repo-root `publisher.json` (`publisher_domain`, Phase 18's one home for the publisher
  domain, D16); a fork that publishes its own app adds its own
  `https://<its-domain>/auth/callback`; `yaranapp://auth/callback` must never be listed,
  because dev builds are recognised by `build=dev` instead.
- `CF_API_BASE_URL` (a `vars` entry, not a secret; Phase 19 hook H3) carries an inline
  comment: the Cloudflare API base URL 05's client calls, default
  `https://api.cloudflare.com/client/v4`; change it only to interpose a test proxy in
  staging. It is a deployer-owned `vars` override under `merge-wrangler` (§7), so an update
  keeps a changed value and lists it in the PR body.

**All three secrets are prompted at deploy (D20). If one is left blank (UNVERIFIED whether
the prompt allows it):** the wizard can still take `CF_API_TOKEN` pasted into the form; it
imports it from the env when present. `SETUP_CODE` and `DATA_KEY` have no in-app fallback:
the setup code is the only thing guarding the pre-Access window, and a Worker cannot write
its own secrets (D20). If `SETUP_CODE` is missing or shorter than 24 characters, or
`DATA_KEY` is missing or fails 04's format check, `/setup` shows the dashboard path to set
it (Worker → Settings → Variables and Secrets) and does nothing else.

### 2. Bootstrap hostname: workers.dev only until setup closes

The custom domain doesn't exist until the wizard creates it (G14), so the first `/setup`
visit has to reach the Worker on its workers.dev hostname. The deploy tree therefore sets
`workers_dev: true` and `preview_urls: false`, and the Worker enforces a **host lock** in
code:

- **Setup open:** only `/setup*`, its assets and `/v1/meta` answer on the workers.dev
  host. Every other route answers `503 setup_incomplete` (04's setup-state rule), so
  nothing but the wizard is reachable before Access exists.
- **Setup closed:** every request whose Host is not the recorded control-plane hostname
  (workers.dev and preview hosts included) gets `421 misdirected_host` (02 §4), whose body
  names no other host, so nothing hints at where the control plane lives. On the
  control-plane host, `/setup*` answers `410 setup_closed`.
- The wizard attaches the custom domain by API (§4 step 6) and, at close, disables the
  workers.dev subdomain by API (`POST …/workers/scripts/{name}/subdomain
  {"enabled":false,"previews_enabled":false}`, G14 step 6). The token needs Workers
  Scripts Write for G14 anyway. If that call fails, the close still completes (the host
  lock already refuses every workers.dev request), the final page says so, and the Health
  page shows workers.dev as still enabled with **Disable workers.dev** as a retry.
- The update workflow (§7) rewrites `workers_dev` to `false` in the deployer's
  `wrangler.jsonc` once the deployed control plane's public `/v1/meta` reports
  `setup: "closed"`. The job reads the URL from the repo variable
  `YARAN_CONTROL_PLANE_URL`, and the wizard's final page tells the admin to set it.
  Until that lands, or if the variable is unset (the PR body then says so), the host
  lock already makes a re-enabled workers.dev inert.

> **Resolved (D19, R5):** `workers.dev` is enabled at deploy, restricted in code to
> `/setup*` and `/v1/meta` until setup closes, and disabled by API at close; afterwards
> every non-custom-domain Host is refused. `preview_urls` is always `false` and no custom
> domain is written into the wrangler config. 04's wrangler file and host guard adopt
> this (04 previously said `workers_dev=false`).

The Worker learns its own script name from the workers.dev Host during setup
(`<script>.<account-subdomain>.workers.dev`). It confirms the name through the token with
`GET /accounts/{id}/workers/scripts/{name}/settings` (shape UNVERIFIED; G14 records it;
fallback: list `workers/scripts` and match by name) and stores it in settings for later
API calls. There is no runtime self-name binding (Evidence).

### 3. Token template and permission manifest

`cloud/worker/scripts/permissions.json` is the one home for every permission the Worker
needs. For each permission it records the ID, name, scope, the endpoint list and the
purpose shown to the admin. `token-template.ts` generates the URL from it, and so does
`npm run token-url`, whose output is pasted into README and binding descriptions. A
test fails if the README link and the manifest drift.

| Permission (scope) | Purpose | Endpoints | ID (source) |
|---|---|---|---|
| Cloudflare Tunnel Edit (account) | create, configure, rotate and delete machine tunnels; read tunnel status | `cfd_tunnel/*` | `c07321b023e944ff818fec44d8203567` (datamine, verify G9) |
| Access: Apps and Policies Edit (account) | control-plane and machine Access apps, reusable policies | `access/apps`, `access/policies` | `1e13c5124ca64b72b1969a67e8829049` (datamine, verify G9) |
| Access: Organizations, Identity Providers, and Groups Edit (account) | read team domain, create One-time PIN / GitHub / Google IdPs, list Access groups, revoke user sessions | `access/organizations`, `access/identity_providers`, `access/groups` | `bfe0d8686a584fa680f4c53b5eb0de6d` (datamine, verify G9) |
| Workers Scripts Edit (account) | attach the custom domain, disable workers.dev, confirm script name | `workers/domains`, `workers/scripts/{name}/subdomain` | `e086da7e2179491d91ee5f35b3ca210a` (official, token-template page) |
| DNS Edit (zone: the chosen zone only) | proxied CNAME per machine | `zones/{id}/dns_records` | `4755a26eedb94da69e1066d98aa820be` (datamine, verify G9) |
| Zone Read (zone: the chosen zone only) | list zones, resolve zone id | `zones` | `c8fed203ed3043cba015a93ad1616f1f` (official) |

Deliberately excluded:

- Access Service Tokens: machines sign with Ed25519 (D6).
- D1 and Workers Builds: the Deploy button uses its own credentials.
- Account API Tokens: the Worker must never mint tokens (`04-token-deploy.md` §3).
- Account Settings Read: added only if G9 shows that `GET /accounts` needs it.

G9 resolves every ID through the permission-groups API and records which group each
endpoint actually accepts (Tunnel vs cloudflared connector, coarse vs fine Access groups).
The manifest is then frozen and the "datamine" markers are removed. **Fallback for G9:**
if an ID-keyed URL doesn't pre-fill, the template uses the documented short keys (`access`,
`access_acct`, `workers_scripts`, `dns`, `zone`). Tunnel has no official short key, so for
that one row the wizard's capability probe (§4 step 2) names the missing permission and
the exact form path.

### 4. Setup wizard (state machine)

`setup/wizard-state.ts` is a pure reducer over the persisted `settings.setup` record, with
one exhaustive `switch`. Each step is idempotent and resumable after a reload.

```text
locked ─code ok─▶ token ─probe ok─▶ org ─team domain─▶ zone ─hostname chosen─▶ access
  ─app+policy+overrides─▶ domain ─attached+cert─▶ idp ─≥1 usable IdP─▶ keys ─VAPID─▶
  claim ─admin SSO verified─▶ closed (terminal; no transition out)
```

Each step:

1. **Setup code.**
   - Constant-time compare of `HMAC(k, input)` against `HMAC(k, SETUP_CODE)`.
   - A wrong code renders `setup_code_invalid` (02 §4) on the page.
   - Rate limits: `rateLimit("setup", ip)` at 5 per minute, plus a D1 failure counter.
     After 20 failures the wizard locks (`setup_locked`) until `SETUP_CODE` changes,
     detected by a stored hash of the code that was in force at lockout.
   - Success issues `__Host-yaran-setup`: HMAC-signed with a key derived from `SETUP_CODE`
     through HKDF, 30 minutes, `HttpOnly; Secure; SameSite=Strict; Path=/`.
2. **Token.**
   - Use the env `CF_API_TOKEN` if present, or a pasted token.
   - Discover the account through `GET /accounts`. **Fallback (UNVERIFIED for account
     tokens, checked by G9):** ask for the account ID, which is shown on the dashboard
     overview, and verify it with `/accounts/{id}/tokens/verify`.
   - Run a **capability probe**: one harmless read per manifest row (list tunnels with
     `per_page=1`, list Access apps, `GET organizations`, list IdPs, list zones, `GET
     script settings`). The admin sees a checklist with each row's purpose.
   - A failed row names the permission and links the template (the same fact 05's client
     reports as `cloudflare_permission_denied` with `details.permission`).
   - The token is stored sealed in D1 (04's `DATA_KEY` helper), which is its one home
     from then on. The admin is told they may delete the Worker secret.
3. **Zero Trust org.**
   - Primary: `GET organizations` returns `auth_domain`, which is recorded as the team
     domain.
   - If no organization exists, the wizard offers "Create the Zero Trust organization"
     through `POST organizations` (G10).
   - **Fallback (G10 fails, or the API refuses for lack of onboarding):** the step shows
     the onboarding path (Zero Trust → choose the Free plan, a payment method is required
     but not charged) and a **Check again** button.
4. **Zone and hostname.**
   - List zones and let the admin pick one.
   - Choose the control-plane label (default `cp`; a single DNS label of 1–63 characters
     with no hyphen, so it can never collide with 05's `<machine>-<user>` pattern). Record
     it as reserved in 05's allocator.
   - Refuse (`hostname_conflict`) if a DNS record or Worker custom domain already uses
     the hostname. The zone
     is fixed once setup closes: machines live under it. The admin console shows it
     read-only, and the docs (17) say a zone move means a new control plane.
5. **Access.**
   - Create the reusable policy **yaran users**: `decision: allow`, with `include` built
     from `Settings.pairing_policy` (02 §6): `mode: allowlist` → one rule per entry of
     `emails`, `domains` (email domain) and `access_group_ids`; `mode: everyone` →
     `{everyone:{}}`. The admin's own email is always included. Setup starts in
     `allowlist` mode with the admin's email. Because One-time PIN admits any address that
     can receive mail, saving `mode: everyone` is refused (`validation_failed`, the message
     says why) while a One-time PIN IdP is enabled on the org.
   - Create the self-hosted control-plane app:
     - `domain` and `destinations: [{type:"public", uri:"<cp-host>", overrides:[{behavior:"public",
       path_pattern:"/v1/meta"}, {behavior:"public", path_pattern:"/v1/machine/*"}]}]`.
       Exactly these two: every machine route matches `^/v1/machine/[a-z]+$` (02 §5, R8),
       so no override for the bare `/v1/machine` exists.
     - `session_duration` from settings, `http_only_cookie_attribute: true`,
       `same_site_cookie_attribute: "lax"`, `enable_binding_cookie: false`
     - the policy attached by id;
     - only if G1 adopts its L2 rung: Managed OAuth `allowed_uris` per 02 §10, i.e. the
       `https://<publisher-domain>/oauth/callback` counterpart of each `APP_CALLBACK_URLS`
       entry (05 writes the same for machine apps).
   - Record `aud`. All calls go through 05's client (budget, retries, idempotency by name
     lookup before create).
   - **G8 primary:** overrides as above. **Fallback (overrides rejected, or precedence
     wrong):** path apps of type `self_hosted` with a reusable **bypass** policy, scoped to
     `<cp-host>/v1/meta` and `<cp-host>/v1/machine/` (G8 Option B). Access picks the most specific
     path app, which G8 verifies. The JWT middleware is unaffected, because those routes
     never require a user.
6. **Custom domain.**
   - `PUT workers/domains {hostname, service: <script name>, zone_id}`, then poll every 5 s
     until Cloudflare reports the certificate active, with a 10-minute cap that says so out
     loud.
   - **G14 fallback (API or permission refused):** the step shows the dashboard path
     (Worker → Settings → Domains & Routes → Add → Custom Domain), and **Check again**
     looks for the hostname through `GET workers/domains`.
   - The Access app already exists, so the hostname is never reachable without Access.
7. **Identity providers.**
   - List IdPs. If the only one is `type:"cloudflare"` (account members only), the step
     explains that teammates can't sign in yet.
   - It offers **Add One-time PIN** (one click, `POST {type:"onetimepin", config:{}}`)
     and forms for **GitHub** and **Google**. Each form takes a client id and secret, shows
     the callback URL to register (`https://<team domain>/cdn-cgi/access/callback`) and
     links the provider's setup page.
   - "Skip" is allowed only when a non-Cloudflare IdP already exists. G10 verifies the
     create shapes in a fresh org.
8. **Keys.**
   - Generate the VAPID key pair (ECDSA P-256, extractable).
   - Store the private JWK sealed in D1 with 04's `DATA_KEY` helper (T41). The 65-byte raw
     public key goes in settings and is exposed as `Meta.push.vapid_public_key` (06) and to
     08.
   - The VAPID `sub` is `https://<cp-host>`.
9. **Admin claim.** The admin email is typed in the token step. The wizard shows a link
   `https://<cp-host>/setup/claim?c=<128-bit code>`, stored hashed, single use, valid for
   30 minutes. That route is **behind Access** (no override), so opening it proves the
   custom domain, Access, the IdP and the Worker's JWT verification end to end. The Worker
   requires a verified JWT whose `email` equals the typed admin email (otherwise, or for an
   unknown, used or expired link, `setup_claim_invalid`), then:
   - inserts the admin user;
   - sets `setup = closed`;
   - deletes the claim code and setup cookie keys;
   - disables workers.dev by API (§2);
   - audits `setup.completed`.

   Then it renders a page that runs the **wiring self-test** in the browser (same origin,
   `credentials:"omit"`):
   - `/v1/meta` must answer 200 JSON with `setup: "closed"`;
   - `/v1/machine/config` must reach the Worker and answer its JSON `signature_missing`
     (not an Access login), which proves the `/v1/machine/*` override;
   - `/v1/me` must not reach the Worker, which proves the protection.

   The results are shown and also re-checkable on the admin Health page.

`closed` is terminal in code. The break-glass procedure for a lost admin is documented in
the tree README and in 17's runbook. It is a `wrangler d1 execute DB --remote` statement
that inserts an admin row, needs account access, and is audited on next start through a
`settings.admin_recovered_at` check.

### 5. Console UI kit and technology choice

**Choice: server-rendered HTML with `hono/jsx`, progressive enhancement, one
self-hosted script, no SPA.** Why:

- A security console is forms and tables. Server rendering works with JS disabled.
- It keeps the deploy tree free of a frontend build beyond one `tsc` emit.
- With no inline script or style, it allows a strict CSP.
- Accessibility comes from native HTML (`<label>`, `<table>`, `<dialog>`), not from a
  widget library.

Not chosen:

- **A React/Vite SPA reusing the yaran web components:** it would drag the web UI's build
  and its shadcn stack into the deployer's repo and its CSP.
- **Plain template strings:** they don't escape automatically.

If 04 chose Hono's router, `hono/jsx` adds no dependency. Otherwise `hono` (MIT, zero
runtime dependencies) is added for JSX alone.

**Shared design tokens (R18).** `packages/ui-kit/` (Phase 14) is the one shared tokens and
components package for the web UI, the app shell and this console, so the console has no
colour generator of its own. `cloud/worker` depends on `@yaran/ui-kit` as a workspace
package; the `build` step copies `packages/ui-kit/src/tokens.css` byte for byte to
`assets/console/tokens.css` (git-ignored on `main`, carried by the assembled tree, so the
deploy branch stays self-contained) together with the Geist variable woff2 (OFL-1.1,
attribution via 17's NOTICE work) into `assets/console/fonts/`. `console.css` is
hand-written and uses only the kit's variable names (`--background`, `--foreground`,
`--card`, `--primary`, `--muted`, `--border`, `--ring`, `--destructive`, …); browsers drop
the kit's Tailwind-only at-rules. The console is dark-only like the web UI
(`main.tsx:8-9`): the shell sets `class="dark"` on `<html>`, so the kit's `.dark` set
applies. A light theme arrives only when the kit gains one. The kit's React components are
not used here, because the console is script-free server-rendered `hono/jsx` and the kit's
components are client React on `@base-ui/react`; the console's kit below mirrors their
semantics (chip, button heights, notice) instead.

**Kit contents** (`src/console/ui/`):

- page shell: landmarks, skip link, `lang`, title, nav;
- `Chip`, the console's `InlineCode` equivalent: every name in prose is a chip, never
  quoted;
- `Button`, at 40 px minimum height with one height token per cluster;
- `Field` (label, hint, error with `aria-describedby`), `Table` (caption, `scope`), `Notice`
  (info, warn, error; icon plus text, never color alone), `EmptyState`, `RelativeTime`
  (server-rendered absolute `<time>`, enhanced to relative);
- `ConfirmAction`: the destructive pattern below.

**Destructive actions.** Every one is a link to a server-rendered confirm page,
`GET /…/:id/<verb>`. The page names the target as a chip, states the consequence, and
places **Cancel** first and autofocused, separated by spacing from a destructive-styled
confirm button. That button POSTs with CSRF protection. `enhance.js` upgrades the same
link to a native `<dialog>` with the same content (opened by a `'self'` script, not inline
handlers). Esc never confirms.

Target-keyed confirm pages refuse with "already removed" when the entity is gone. The
outcome lands on a notice that names what happened, because a row vanishing is too small
to trust (CLAUDE.md confirmation rule).

**Security headers** (`src/console/ui/security-headers.ts`, applied to every HTML response
via `secureHeaders`, and to assets via `assets/_headers`):

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'
```

It also sets HSTS, nosniff, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`
on authenticated pages. Form posts go through `hono/csrf` (Origin / `Sec-Fetch-Site`)
on top of the `SameSite=Lax` Access cookie. JSON admin routes additionally require
`Content-Type: application/json`, which `hono/csrf` doesn't cover. Strings live in
`src/console/ui/strings.ts`, the English baseline, written in the house voice: verbose and
actionable.

### 6. Consoles and admin API

One service layer, two adapters. Each console handler and each `/v1/admin/*` JSON route
(02 W17–W28) calls the same service functions: 05/06 services plus `src/admin/*` here.
Authorization comes from 04's `requireUser`/`requireAdmin` (T54, T34). Admin pages live at
`/admin/*` and the user console at `/` (02 W30). Refusals use 02's registry codes (for
example `last_admin`, `forbidden`, `tunnel_delete_blocked`) rendered on the page.

**User console:**

- **My machines:** the 06 view model (`MachineSummary`), with `status`, last seen and
  hostname link, plus **Unpair…** (confirm, W11). There is no rename: the name is part of
  the hostname, Access app and DNS record, and the page says "to rename a machine, unpair
  it and pair it again" (02 §5).
- **My phones:** label, platform, flavor, push channel, `push_state` (worded:
  `gone` → "push stopped: the subscription expired", `auth_failed` → "push stopped: the
  phone must register again", `failing` → "push is failing", `none` → "push off"), mutes,
  app version, last seen, plus **Remove…** (confirm, W14, with the "also sign out
  everywhere" checkbox and its honest caveat from 06).
- **Connect a phone:** 06 `phoneQrSvg`, the org URL as a chip, and app store and F-Droid
  links from build config (placeholders, D16).
- **Connect a machine:** the copyable `yaran cloud login https://<cp-host>` and a pointer
  to the TUI palette and web menu entries (09).

**Admin console:**

| Page | Content | Actions (all audited; destructive ones confirm) |
|---|---|---|
| Users | email, role, status, machines, phones, last seen (`AdminUser`, W17) | promote or demote admin (W18; refuses demoting the last admin with `last_admin`); **Disable…** with an optional "also revoke all their machines and phones and sign them out" (`AdminUserPatch {disabled: true, revoke_all: true}`: 05 teardown, 06 device revoke, 06's `revokeUserSessions`); enable |
| Machines | all machines as `AdminMachine` (W20): the 06 view model plus owner, key fingerprint (02 §7.1, mono chip), origin port, provisioning state, token version, paired, reported protocol, stale badge | **Revoke…** (W21, 05 teardown); **Rotate tunnel token…** (W22 `{kill_connections}`, mapped to 05's `evict`; the machine picks it up on its next signed call) |
| Devices | all phones as `AdminDevice` (W23; no endpoints or keys), with `push_state` worded as on the user console | **Remove…** (W24) |
| Audit log | filter by actor, action, target and date range (W25); cursor pagination | **Export** JSON Lines for the current filter |
| Settings | see below (W26) | save validates first, then applies side effects through 05 and reports each one |
| Health | self-test results; Access app, the two overrides (`/v1/meta`, `/v1/machine/*`) and policy present; custom domain attached; workers.dev disabled; IdPs; quotas used (Access apps, policies, tunnels vs `quota_limits`); API budget; last reconciliation | **Re-run checks**; **Disable workers.dev** (only while it is still enabled); **Replace API token…** (capability probe first) |
| Updates | `UpdateStatus` (W27): running version, latest version, security flag, notes link, last check and error, procedure | **Check now** |

**Settings** (`src/admin/settings-schema.ts`, one home: it renders exactly 02's `Settings`
schema (§6), adding only defaults, ranges and help text, which renders as the field hint,
so the page documents itself; `PUT /v1/admin/settings` replaces the whole object and is
validated by 02's validator first; audit `settings.updated`):

| Setting | Default | Effect |
|---|---|---|
| `org_name` | zone name | `Meta.org.name`, page titles |
| `session_duration` | `24h` (15m–720h) | 05 re-applies to the control-plane app and every machine app and policy (budgeted job, progress shown) |
| `pairing_policy` | `{mode: allowlist, emails: [admin], domains: [], access_group_ids: []}` | rewrites the **yaran users** policy `include` (§4 step 5; groups chosen from `GET access/groups`, shape verified in G10); 06 refuses non-listed emails with `pairing_not_allowed` |
| `machine_cap_per_user` | 10 (1–50) | 06 |
| `device_cap_per_user` | 10 (1–20) | 06 |
| `push.enabled` | on | 08 honours it; `Meta.push.enabled` |
| `push.detail` | `names` | `MachineConfig.push.detail`: `minimal` makes yaran omit project and label from events (12, 08) |
| `push.ttl_seconds` | 3600 (60–86,400) | 08's Web Push `TTL` |
| `push.relay_allowed` | on | off refuses relay channels (`push_relay_disallowed`, reason `disabled`; iOS push off), 06 and 08 |
| `push.allowed_relays` | empty (any https relay) | 06 refuses relay endpoints outside the list (`push_relay_disallowed`, reason `not_allowlisted`) |
| `stale_machine_policy` | `{notify_after_days: 30, revoke_after_days: null}` (`null` = off) | `src/admin/stale-policy.ts` gives a pure verdict, run from 05's reconciliation cron |
| `audit_retention_days` | 365 (30–3650) | daily sweep from the shared cron |
| `quota_limits` | `{access_apps: 500, access_policies: 500, tunnels: 1000}` | 05's quota guard (raise only after Cloudflare raises the account limit; a lower value is a soft cap, Phase 19 hook H5) |
| `orphan_cleanup` | `delete` | 05's orphan sweep: `delete` or `report` only |
| `deployer_repo_url` | `null` | deep link from Updates to the update workflow run page |

The stale verdict is `keep | notify | revoke`, from offline age and the policy, with an
exhaustive table test. `notify` puts a badge on the user's and the admin's machine list,
and `revoke` calls 05 teardown with reason `stale`, audited with actor `system`.

### 7. Update checker and update procedure

**Release manifest** (02 §6 `ReleaseManifest`, `cloud/protocol/schemas/release-manifest.schema.json`;
02 owns the schema, one home):

```text
{ train:"yaran-cloud", version, tag, released_at, protocol:{min,max}, min_update_from,
  security:boolean, notes_url, tarball:{url, sha256} }
```

The assembler writes it into the tree, so `release-cloud.yml` (18) publishes it at
`cloud-deploy:worker/release.json` with every tree it pushes.

**Checker** (`src/update/update-checker.ts`): it runs from 05's one-minute cron, and only
when more than 24 h have passed since the last check, so it takes no extra cron slot.

1. Primary: fetch
   `https://raw.githubusercontent.com/SiavZ/yaran/cloud-deploy/worker/release.json`.
   This isn't subject to the REST API's 60/hour limit. Its own limits are UNVERIFIED, so
   one fetch per day per org is the budget.
2. Fallback: `GET https://api.github.com/repos/SiavZ/yaran/releases?per_page=30`, filtered
   to `yaran-cloud-v` tags, newest by semver.
3. Validate against the schema, compare against the build-time `WORKER_VERSION`, and cache
   the result in settings as 02's `UpdateStatus` (`current`, `latest`, `notes_url`,
   `update_available`, `security`, `checked_at`, `error`).

Failures are shown as "couldn't check since <time>" with the reason, never as "up to date".
Admins see a banner when an update exists, red when `security` is set. `/v1/admin/update-status`
serves the same data. The manifest is only advisory. Authenticity is enforced where code
actually changes: in the update job.

**Update job** (`scripts/update/*.ts`, wrapped by `.github/workflows/yaran-cloud-update.yml`,
weekly plus manual, and `.gitlab-ci.yml`):

1. `fetch-release.ts`:
   - resolve the newest `yaran-cloud-v*` release (same rules as the checker);
   - download the tarball and `.sha256`, and verify the hash;
   - on GitHub, also run `gh attestation verify <tarball> --repo SiavZ/yaran`;
   - refuse if the running version is below `min_update_from` and name the stepping-stone
     release.
2. `apply-update.ts`: replace every upstream-owned path. The tarball's `manifest` lists
   them, which preserves deployer files outside the list.
3. `merge-wrangler.ts`: carry the deployer-owned values from the current `wrangler.jsonc`
   (`name`, `d1_databases[].database_id/database_name`, `routes`, `vars` overrides,
   `account_id` if present) onto the new template. `APP_CALLBACK_URLS` is upstream-owned:
   the new release's value replaces it unless the deployer's value differs from the
   previous release's default, in which case it is kept and listed in the PR body. It
   never adds a custom domain or route of its own or `preview_urls: true`, and sets `workers_dev:false` when
   `YARAN_CONTROL_PLANE_URL`'s `/v1/meta` reports `setup: "closed"`. Unknown deployer keys are kept and listed in
   the PR body.
4. Open a pull request titled "Update yaran control plane to vX.Y.Z" whose body carries
   the release notes link, the security flag and the preserved keys. Merging it triggers
   Workers Builds, and the `deploy` script applies migrations first.

The GitHub job needs `contents: write` and `pull-requests: write` plus the repo setting
"Allow GitHub Actions to create pull requests". The README says so, and the job fails
with that exact instruction if the PR call is refused.

**Manual procedure** (README, and 17's docs; the same scripts run locally):

```bash
npm run update -- --version X.Y.Z
git push
```

That is `fetch-release`, then `apply-update`, then `merge-wrangler`, then
`git commit` on a branch. The admin then merges.

## Work items

Every file starts with the 00-CONVENTIONS §2 header and has its generated
`<module-headers>` block. Each is planned at ≤ 500 lines (estimates in parentheses). Tests
use 04's `@cloudflare/vitest-pool-workers` harness and 05's recorded Cloudflare fixtures.
Work item 1 lands first because 06's pages consume it.

1. **Console UI kit.**
   - Create `cloud/worker/src/console/ui/shell.tsx` (~150), `components.tsx` (~300),
     `confirm.tsx` (~150), `security-headers.ts` (~80) and `strings.ts` (~250).
   - Create `cloud/worker/assets/console/console.css` (hand-written, `@yaran/ui-kit` token
     variables only), `enhance.ts` (~200: dialog upgrade, copy buttons, relative time,
     self-test runner), `assets/_headers`, `tsconfig.assets.json`, and
     `scripts/copy-ui-kit-assets.ts` (~60, run by `build`: copies
     `packages/ui-kit/src/tokens.css` and the Geist woff2 into `assets/console/`, no
     transformation).
   - Touch `cloud/worker/package.json`: add `"@yaran/ui-kit"` as a workspace dependency
     (14's package).
   - Reuse: `packages/ui-kit/src/tokens.css` (14) as the only token source, and the chip
     semantics of the kit's `inline-code.tsx`.
   - Tests:
     - Render snapshots, plus an a11y assertion helper: every input has a label, every
       table a caption, buttons ≥ 40 px via a class, focus order on the confirm (Cancel
       first).
     - A CSP test renders every page and asserts no inline `<script>`, `style=` or `on*=`.
     - The built `assets/console/tokens.css` is byte-identical to
       `packages/ui-kit/src/tokens.css`, and `console.css` references no colour literal
       (a lint test: no `#hex`, `rgb(`, `oklch(` outside `var(--…)`).

2. **Deploy tree assembler and button.**
   - Create `cloud/worker/scripts/assemble-deploy-tree.ts` (~280).
   - Create `cloud/worker/deploy-template/` (the tree README, `.dev.vars.example` with
     `CF_API_TOKEN`, `SETUP_CODE` and `DATA_KEY`, the workflow, `.gitlab-ci.yml`,
     `wrangler.template.jsonc` with `workers_dev: true`, `preview_urls: false`, no routes,
     and the commented `APP_CALLBACK_URLS` and `CF_API_BASE_URL` vars; Phase 19 hook H3).
   - Touch `cloud/worker/package.json` (`cloudflare.bindings`, scripts) and the root
     `README.md` (badge plus one sentence; 17 owns the surrounding copy).
   - Reuse: 02's protocol build output and 14's `tokens.css`; 18's `release-cloud.yml`
     calls the assembler and pushes the generated `cloud-deploy` branch.
   - Tests:
     - Assemble into a temp dir, then `npm ci` and `npx wrangler deploy --dry-run` inside
       it with no access to the monorepo (a sandboxed copy).
     - A grep test that no import resolves outside the tree.
     - The tree validates against Deploy-button requirements: `name`, `main` and
       `compatibility_date` are present, and no binding ids.
     - The tree's `wrangler.jsonc` has `workers_dev: true`, `preview_urls: false`, no
       `routes` or custom domain, and `.dev.vars.example` lists exactly the three D20
       secrets.
     - `APP_CALLBACK_URLS` equals the list derived from the `publisher.json` passed in;
       `CF_API_BASE_URL` defaults to `https://api.cloudflare.com/client/v4` and carries its
       inline comment (H3); `merge-wrangler` keeps a deployer's changed value.

3. **Permission manifest and token template.**
   - Create `cloud/worker/scripts/permissions.json`, and
     `cloud/worker/src/setup/token-template.ts` (~100), shared by the script and the
     wizard.
   - Tests: the URL encoding round-trips; the README link matches generator output;
     every manifest row has a purpose, endpoints and a scope.
   - G9 evidence replaces the datamine IDs in the same PR that closes G9.

4. **Wizard core.**
   - Create `cloud/worker/src/setup/wizard-state.ts` (~200), `setup-gate.ts` (~180: code
     check, lockout, cookie), `host-lock.ts` (~90, mounted by 04's router before all
     routes) and `capability-probe.ts` (~180).
   - Tests:
     - The reducer table covers every state × event and the closed state is terminal.
     - Lockout after 20 failures and unlock on code change.
     - Timing-safe comparison is used (spy).
     - The host lock is checked in both setup states: while open, workers.dev serves only
       `/setup*` and `/v1/meta` (others `503 setup_incomplete`); once closed, every
       non-control-plane Host gets `421 misdirected_host` whose body leaks no hostname, and
       `/setup*` on the control-plane host gets `410 setup_closed`.
     - Wrong code renders `setup_code_invalid`; lockout renders `setup_locked`.
     - Capability probe: each missing permission maps to its manifest row.

5. **Wizard steps.**
   - Create `cloud/worker/src/setup/steps/org.ts` (~120), `zone.ts` (~150),
     `access.ts` (~220, primary and G8 fallback), `domain.ts` (~170, primary and G14
     fallback), `idp.ts` (~200), `keys.ts` (~90), `claim.ts` (~180), and pages
     `cloud/worker/src/setup/pages.tsx` (~350) plus `pages-steps.tsx` (~300) if the step
     views exceed one file.
   - Add the needed operations to 05's client (`access.createApp/updateApp`,
     `access.createPolicy`, `idp.list/create`, `org.get/create`, `workers.attachDomain`,
     `workers.setSubdomain`, `workers.getScriptSettings`, `access.listGroups`) as a new
     module `cloud/worker/src/cloudflare/setup-endpoints.ts` (~250) beside 05's endpoint
     modules.
   - Tests:
     - Each step against recorded fixtures, including idempotent re-run after partial
       failure: an app that already exists is found by name, not duplicated.
     - The Access app body snapshot asserts exactly the two overrides (`/v1/meta`,
       `/v1/machine/*`), `enable_binding_cookie:false`, HttpOnly and `lax`.
     - `pairing_policy` → `include` mapping table; `mode: everyone` refused while One-time
       PIN is enabled.
     - The publishing order is asserted: the domain is attached only after the app exists,
       and workers.dev is disabled (`enabled:false`, `previews_enabled:false`) at close; a
       failed disable still closes setup and surfaces on Health.
     - The claim refuses (`setup_claim_invalid`) a JWT whose email isn't the typed admin's,
       as well as reuse and expiry, and audits `setup.completed` on success.
     - VAPID: generated, sealed, and the public key round-trips.
     - Integration: the full wizard in Miniflare with a fake Cloudflare API server.

6. **Settings, admin services and stale policy.**
   - Create `cloud/worker/src/admin/settings-schema.ts` (~200), `settings-apply.ts`
     (~200: side effects through 05), `users.ts` (~200), `stale-policy.ts` (~80),
     `audit-query.ts` (~180: filters, cursor, JSONL export, retention sweep), `health.ts`
     (~200) and `api-token.ts` (~100: replace with probe).
   - This work item implements Phase 19's hook **H5** for the knobs 02's `Settings`
     carries: `session_duration` down to the 15-minute floor, `machine_cap_per_user`, and
     `quota_limits.access_apps` as a soft cap below Cloudflare's 500, all writable through
     `PUT /v1/admin/settings`. The reconciliation interval is not in 02's `Settings` (see
     Risks).
   - Tests: `settings-schema.ts` accepts every valid and refuses every invalid
     `fixtures/api/Settings/*` file from 02 (so the console form cannot drift from the
     contract); refusing to demote the last admin (`last_admin`); `AdminUserPatch
     {disabled: true, revoke_all: true}` calls 05/06 in order; stale verdict table
     (`null` = off); export streams with filters; the retention sweep deletes only rows
     older than the setting.

7. **Admin and user console pages and admin API.**
   - Create `cloud/worker/src/console/user-pages.tsx` (~300),
     `cloud/worker/src/console/admin-pages.tsx` (~400), `admin-pages-2.tsx` (~300; split
     by page group to stay under 500), `cloud/worker/src/console/routes.ts` (~250), and
     `cloud/worker/src/admin-api/routes.ts` (~250) implementing 02's W17–W27 paths (W28 is
     05's).
   - Reuse 06's `machine-view-model.ts`, `qr.ts` and devices repo, and 05's
     teardown/rotation.
   - Tests:
     - Authz matrix: user vs admin vs disabled vs no JWT vs service token, across every
       route.
     - Every destructive route needs POST plus CSRF and has a confirm page.
     - Gone-target confirm pages answer "already removed".
     - Outcome notices name the target.
     - JSON routes refuse non-JSON content types and a foreign `Origin` (`origin_mismatch`);
       responses validate against 02's `AdminUser`, `AdminMachine`, `AdminDevice`,
       `AuditEntry`, `Settings` and `UpdateStatus`.
     - The phones lists word every `push_state`, `gone` as "push stopped: the subscription
       expired".

8. **Update checker and update job.**
   - Create `cloud/worker/src/update/release-manifest.ts` (~120, over 02's
     `ReleaseManifest` validator; the schema file itself is 02's),
     `cloud/worker/src/update/update-checker.ts` (~180), and
     `cloud/worker/deploy-template/scripts/update/fetch-release.ts` (~200),
     `apply-update.ts` (~150) and `merge-wrangler.ts` (~180).
   - Tests:
     - Manifest schema fixtures (valid, missing fields, bad semver).
     - The checker prefers raw, falls back to the API, and never reports "up to date" on
       error.
     - The 24 h gate uses an injected clock.
     - `merge-wrangler` preserves every deployer-owned key, flips `workers_dev` only when
       setup is closed, applies the `APP_CALLBACK_URLS` rule, never adds a route or
       `preview_urls: true`, and lists unknown keys.
     - `fetch-release` refuses a hash mismatch or a too-old `min_update_from`.
     - End-to-end: apply vX → vX+1 onto an assembled tree in a temp git repo and diff the
       expected file set.

9. **Wiring.** Touch `cloud/worker/src/router.ts` (mount host lock, setup, console,
   admin API: wiring only) and `cloud/worker/src/scheduled.ts` (register the update
   check, stale policy and audit retention on the existing cron).

## Acceptance

- [ ] The assembled tree builds and dry-run deploys with no file from outside it; `main`
      holds no vendored protocol copy and no generated theme. The README badge points at
      the generated branch `…/tree/cloud-deploy/worker`, and G11 has passed against it (or
      the root-branch fallback is adopted and recorded). The tree prompts for exactly
      `CF_API_TOKEN`, `SETUP_CODE` and `DATA_KEY`, and its wrangler config has
      `workers_dev: true`, `preview_urls: false` and no custom domain.
- [ ] The token template link is generated from `permissions.json`. Every ID is resolved
      via the permission-groups API (G9 evidence), and every permission has a documented
      purpose. No token-minting, D1, or service-token permission is requested.
- [ ] `/setup` is reachable only on workers.dev while setup is open and only with the
      setup code; nothing but `/setup*` and `/v1/meta` answers there. Brute force locks out
      (`setup_locked`). A missing or weak `SETUP_CODE`, or a missing or malformed
      `DATA_KEY`, is explained.
- [ ] The wizard creates the control-plane Access app (overrides for `/v1/meta` and
      `/v1/machine/*` only; binding cookie off) **before** attaching the custom domain by
      API. Each step is idempotent and resumable.
- [ ] IdP step detects a Cloudflare-only org and can add One-time PIN, GitHub or Google
      by API (G10), or shows the dashboard fallback.
- [ ] Admin claim succeeds only through Access with the typed admin email. Setup becomes
      permanently closed (`setup.completed`), workers.dev is disabled by API, and every
      non-control-plane Host answers `421 misdirected_host` naming no other host.
- [ ] The browser self-test shows `/v1/meta` public, `/v1/machine/*` reaching the Worker,
      and `/v1/me` protected.
- [ ] VAPID key generated, private half sealed, public half served.
- [ ] Admin console: users, machines (with key fingerprint and origin port), devices
      (with `push_state`), audit log with export, settings rendering exactly 02's
      `Settings`, health with quotas, updates (`UpdateStatus`). User console: machines, phones, phone QR,
      connect a machine. Every destructive action confirms with Cancel focused, and every
      outcome is confirmed in words.
- [ ] Every page passes the CSP test (no inline script, style or handlers) and the a11y
      assertions. The pages work with JS disabled.
- [ ] The console's tokens are `packages/ui-kit/src/tokens.css`, copied verbatim by the
      build; no separate colour generator exists.
- [ ] The update checker reports the latest `yaran-cloud-v*` (raw manifest, API fallback)
      and never claims "up to date" on failure. The update job verifies hash and
      attestation, preserves deployer wrangler values, and opens a PR. The manual
      procedure is documented and tested.
- [ ] All new files are ≤ 500 lines with generated headers. `module-headers --check`
      passes.

## Validation

```bash
cd cloud/worker
npm ci && npm run typecheck && npm test
npm run build && cmp assets/console/tokens.css ../../packages/ui-kit/src/tokens.css
npm run token-url | diff - <(grep -o 'https://dash.cloudflare.com/?to=[^)]*' deploy-template/README.md)
OUT=$(mktemp -d) && npm run assemble-deploy-tree -- --out "$OUT" \
  && (cd "$OUT/worker" && npm ci && npm run build && npx wrangler deploy --dry-run --outdir "$OUT/dist")
cd ../.. && node tools/module-headers/bin/module-headers.mjs --check cloud/worker cloud/protocol
node tools/module-headers/bin/module-headers.mjs --lines --check cloud/worker cloud/protocol
# live gates (maintainer staging account):
tools/cloud-gates/run.sh G8 G9 G10 G11 G14
```

## Risks

| Risk | Mitigation |
|---|---|
| Pre-Access setup window on workers.dev | The setup code must be ≥ 24 characters, with a rate limit and lockout. Only `/setup*` and `/v1/meta` answer. The window closes permanently at admin claim and workers.dev is disabled by API. Threat model T33 (and T31 for the workers.dev window, T47 for the three deploy secrets) |
| A later deploy re-enables workers.dev (a dashboard toggle or the template's `workers_dev: true`) | Resolved design (D19, R5): the host lock answers `421 misdirected_host` on any non-control-plane Host after setup, and the update job flips the deployer's config to `workers_dev: false` once `/v1/meta` reports `setup: "closed"`. 04 previously said `workers_dev=false`; it adopts D19 |
| Disabling workers.dev by API fails at close | Setup still closes (the host lock already refuses); the final page and the Health page say so and offer a retry |
| Deploy button can't build a monorepo subdirectory with shared deps | The assembled, self-contained tree on the generated `cloud-deploy` branch (D18). G11 proves it, and the root-branch fallback is specified |
| Secret prompt may refuse blank values | All three secrets are prompted (D20). The token can still be pasted in the wizard; `SETUP_CODE` and `DATA_KEY` must be set, and their descriptions give generator one-liners |
| `pairing_policy.mode = everyone` with One-time PIN would admit any email address | Saving that combination is refused with an explanation; setup starts in `allowlist` mode (T54) |
| The admin settings omit a knob Phase 19's H5 asks for (reconciliation interval) | 02 keeps 05's drift and budget settings as Worker-internal rows, not contract; the console does not render them. Reported to the plan lead (H5 needs either a 02 `Settings` field or a staging-only override in 05) |
| Malicious or spoofed upstream release reaches a deployer | The update job verifies hash and GitHub attestation before opening a PR, and the manifest is advisory only (T52) |
| VAPID private key leak | Sealed with `DATA_KEY` in D1, never shown, never exported (T41) |
| Datamined permission IDs wrong or renamed | G9 re-resolves every ID. The short-key fallback and the capability probe name any missing permission |
| `GET /accounts` not allowed for account tokens | The account-ID field fallback, verified by `tokens/verify` |
| Fresh account without Zero Trust onboarding | The org step detects it, explains the payment-method requirement, and offers Check again |
| Access overrides rejected or precedence wrong (G8) | A bypass-policy path app is specified as the fallback. The Health page verifies whichever is in force |
| Custom-domain API refused (G14) | Dashboard instructions plus a Check again poll. The Access app already exists, so the hostname is never exposed unprotected |
| raw.githubusercontent limits UNVERIFIED; API 60/h shared IPs | Once per 24 h, API fallback, honest "couldn't check". The update job does its own verified fetch |
| Deployer edits upstream-owned files | The PR shows the overwrite. The tree README names the deployer-owned surface (wrangler values, `vars`) |
| Deployer repo on GitLab has no `gh attestation` | Hash verification always. The GitLab job documents that provenance verification needs `gh` installed and runs it when available |
| CSP blocks QR SVG or style attributes | 06's QR test asserts no `style=`. The kit uses classes only, and the CSP test covers every page |

## References

- `00-README.md` "What done means" 1 and 5, D2, D5, D6, D8, D11, D15, D16, D18, D19, D20,
  flow 1 and 6
- `02-protocol-contract.md` §4 (codes), §5 (W17–W30), §6 (`Settings`, `AdminUser`,
  `AdminMachine`, `AdminDevice`, `UpdateStatus`, `ReleaseManifest`), §7.1, §8
  (`APP_CALLBACK_URLS`); `14-mobile-app-foundation.md` (`packages/ui-kit`); threat IDs T31,
  T33, T34, T41, T47, T52, T54 (`17-docs-website-threat-model.md`)
- `00-CONVENTIONS.md` §1–§6; repo `CLAUDE.md` web tenets (destructive confirm, chips,
  touch targets, confirmation rule) applied to the console
- `research/cloudflare-parts/04-token-deploy.md` (all), `05-workers.md` §1, §7,
  `02-access.md` §1, §2, §6, §7; `R4-cloudflare.md` Hard constraints 3, 4, 14 and
  Recommendations (`:1238-1289`); `R3-repo-process.md` §Implications 3, 7
- Cloudflare: deploy-buttons, account-owned-token-template, workers-dev, previews,
  custom-domains, version-metadata, web-crypto, static-assets/headers; API reference for
  workers/domains, scripts/subdomain, access apps, policies, identity_providers,
  organizations, tokens/verify, permission_groups (checked 2026-11-14)
- GitHub REST rate limits and best practices (checked 2026-11-14)
- hono.dev: jsx, csrf, secure-headers (checked 2026-11-14); MDN `<dialog>`, Invoker
  Commands
- `docs/contributing/schema-policy.md`; `.github/workflows/release.yml:56-70,257`;
  `.github/BRANCH_PROTECTION.md:44-45`

## Reconciliation notes (2026-11-14)

- Header: Depends on adds code-level 14 (`packages/ui-kit`, R18); wave placement unchanged (Wave B).
- R6/D20: "pastes one pre-scoped API token, enters a setup code" replaced by the three deploy-time secrets `CF_API_TOKEN`, `SETUP_CODE`, `DATA_KEY` in Goal, deploy tree, `.dev.vars.example`, binding descriptions (new `DATA_KEY` text), blank-secret fallback, acceptance and Risks.
- R4/D18: Deploy button targets the generated `cloud-deploy` branch built by `release-cloud.yml`; `main` imports `cloud/protocol` as a workspace package with no vendored copy; the bundle exists only on the generated branch; "never `cloud-stable`" stated.
- R5/D19: host lock rewritten (open: only `/setup*` and `/v1/meta` on workers.dev, others `503 setup_incomplete`; closed: `421 misdirected_host`, `/setup*` → `410 setup_closed`); wizard attaches the custom domain by API then disables workers.dev by API (`previews_enabled:false` too) with a Health retry on failure; `preview_urls: false`, no custom domain in wrangler; the "conflict with 04" block marked resolved.
- R8: the second override for bare `/v1/machine` removed from the wizard, Health, tests and acceptance; overrides are exactly `/v1/meta` and `/v1/machine/*`; G8 fallback paths aligned to 03 (`/v1/machine/`); self-test adds a `/v1/machine/config` probe.
- R18: `scripts/sync-theme.ts` and the generated `theme.css` removed; the console copies `packages/ui-kit/src/tokens.css` verbatim (14) and uses its variables; ui-kit's React components are not reused (script-free SSR), stated.
- Settings table and work item 6 now render exactly 02's `Settings` (`pairing_policy {mode, emails, domains, access_group_ids}`, `push {enabled, detail, ttl_seconds, relay_allowed, allowed_relays}`, `stale_machine_policy` with `null` = off, `quota_limits`, `orphan_cleanup`, `deployer_repo_url: null`); tests read 02's `fixtures/api/Settings`.
- New design: `pairing_policy` → Access `include` mapping, and `mode: everyone` refused while One-time PIN is enabled.
- Error codes from 02's registry: `setup_code_invalid`, `setup_locked`, `setup_claim_invalid`, `misdirected_host`, `setup_closed`, `setup_incomplete`, `hostname_conflict`, `cloudflare_permission_denied`, `last_admin`, `origin_mismatch`, `push_relay_disallowed`.
- Canonical names: audit `setup.closed` → `setup.completed`; `AdminUserPatch {disabled, revoke_all}`; `AdminMachine` (key fingerprint per 02 §7.1, origin port); `AdminDevice` and user phones list word `push_state` (`gone` → "push stopped: the subscription expired", R11); `UpdateStatus`; `ReleaseManifest` owned by 02 (work item 8 no longer creates the schema); `Meta.push.vapid_public_key`; W17–W30 cited.
- `APP_CALLBACK_URLS` added to the deploy template (inline comment) and to `merge-wrangler` (upstream-owned, deployer override kept and listed) per 02 §8 (R2); Managed OAuth `allowed_uris` noted for G1 L2 only.
- 05 client path fixed: `src/cf/setup-endpoints.ts` → `src/cloudflare/setup-endpoints.ts` (05's module tree); disable-and-revoke reuses 06's `revokeUserSessions`.
- My machines states "unpair and pair again" for renames (02 §5).
- R15: work item 6 names Phase 19 hook H5; the reconciliation-interval knob is absent from 02's `Settings` and is reported.
- R14: threat IDs added (T31, T33, T34, T41, T47, T52, T54); "Threat-model row (17)" placeholders replaced.
- R1 not applied to the setup cookie's HKDF key derivation (§4 step 1): it is unrelated to the handoff envelope.

### Straggler pass (2026-11-14)

- Straggler pass: "never `cloud-stable`" phrase dropped from §1 (branch is `cloud-deploy`, R4); §1 cross-refs 18's `cloud-deploy-rc` branch for release-candidate trees.
- Straggler pass: the Evidence bullet on `workers_dev = false` now explains why the tree ships `true` and how §2 and the update workflow reach `false` (R5, D19); 07 and 03 G14 agree.
- Straggler pass: D20 checked at work item 6/7 and everywhere else: all places name the three secrets; no conflict found, no edit (R6).
- Straggler pass: Phase 19 hook H3: deploy tree declares the commented `CF_API_BASE_URL` var (binding description, tree listing, work item 2 and its test) (R15).
- Straggler pass: `APP_CALLBACK_URLS` is derived from 18's repo-root `publisher.json`; work item 2 tests it (R2, D16).
- Straggler pass: Validation uses 01's real CLI (`bin/module-headers.mjs --check <paths>`, `--lines --check`) instead of `dist/cli.js`/`--max-lines` (R20).
