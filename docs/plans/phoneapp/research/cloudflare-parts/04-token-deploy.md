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
