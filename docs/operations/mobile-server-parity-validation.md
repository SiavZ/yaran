# Mobile parity, server side: implementation and validation ledger

Tracks A and F of `t3-mobile-parity-implementation-plan.md`, server, web and cloud side
only, against the frozen contract in `mobile-parity-contracts.md`. Date: 2026-11-17.
Values someone else supplies are written as `<publisher-domain>`, `<org-control-plane>`
and `<machine-host>`. Nothing here was deployed, committed or run against a live phone,
browser, tunnel or control plane.

## 1. What changed

| Area | File | Change |
|---|---|---|
| D1(a) gate | `crates/yaran-web/src/auth/routes.rs` | `POST /api/v1/auth/cli-login` answers an additive `cookie_name` (`yaran_session_<port>` of the listener the request arrived on, `null` over the control socket). `token` and `expires_at` are unchanged; the command line's parser reads only `token`. No auth, kind, idle or ownership rule changed. |
| URI twins | `crates/yaran-core/src/cloud/protocol/links.rs` (new) | Rust `is_public_host`, `add_machine_uri`, `parse_add_machine_uri`, `AgentLink`, `agent_link_url`, `parse_agent_link`, matching `cloud/protocol/src/uri.ts` (unchanged) row for row on its fixtures, plus `publisher_domain_from_callbacks`. `uri.rs` only exposes its encode set to the crate. |
| Protocol | `cloud/protocol/schemas/machine.schema.json`, `scripts/vectors/api-cases-machine.mjs`, generated `fixtures/api/MachineConfig.json` and `src/generated/types.ts` | `MachineConfig.publisher_domain`: optional, additive, a public host. One new valid case and three invalid ones (port, single label, `xn--`). The URI generator and URI fixtures are untouched. |
| Rust protocol | `crates/yaran-core/src/cloud/protocol/machine.rs` | `publisher_domain: Option<String>` (`serde(default)`, skipped when absent), validated as a public host when present. An older yaran ignores the field (the response type is open); this yaran reads an older Worker's answer as `None`. |
| Worker | `cloud/worker/src/machine-api/config.ts` | W5 adds `publisher_domain` when the https `APP_CALLBACK_URLS` ending `/auth/callback` name exactly one public host; omits it otherwise. `wrangler.jsonc` is not touched. |
| Routes | `crates/yaran-web/src/cloud_phone_links.rs` (new), wired in `lib.rs` and `server.rs` | `GET /api/v1/phone/machine-qr` and `GET /api/v1/phone/link-target`, behind the same auth layer as every route (see section 2). |
| Web | `components/ConnectPhoneDialog.tsx`, `lib/phoneApi.ts`, `lib/phoneLink.ts`, `components/CopyPhoneLinkItem.tsx`, `AgentActionsMenu.tsx`, `AgentTabsStrip.tsx`, `lib/useAppMenuContext.ts`, `lib/appMenu.ts` | **Connect a phone…** is offered on every browser page (not inside the app), paired or not. It shows the org code while paired and, in its own section, this machine's direct code or the server's refusal sentence. **Copy phone link** is in the agent's group of the pane menu (first tab) and in each tab pill's `⋯` (that tab; the first tab is linked without `t`). |
| Security | `SECURITY.md`, `docs/operations/threat-model.md` | Appended T67 (phone-held direct session), T68 (add-machine code), T69 (agent links). No row renumbered. |
| Docs | `website/docs/mobile-apps.md`, `cloud-connect-machine.md`, `cloud-troubleshooting.md` | Adding a machine without Cloud Connect, phone links, the `app_callback_urls` row, and each new refusal quoted from the code. |
| Gate | `tools/module-headers/baseline-oversize.json` | Reviewed growth for six oversize files, wiring only (1 to 7 lines each); the new tests live in new files. |

## 2. Decisions taken here

- **HTTPS proof.** Only `Classification.https_serve_route` counts: a confirmed `tailscale
  serve` HTTPS route or a Funnel, the same fact the cookie's `Secure` flag uses. A client's
  `X-Forwarded-Proto` never counts. `cookie_secure = "always"` (the owner's own proxy) does
  not count either, because it is the owner's statement about the cookie and not proof about
  this request; such owners type the address into the app.
- **Host.** The `Host` header the host guard already allowed, required to pass
  `is_public_host` (so no IP, port, uppercase or `xn--`), and never equal to the paired
  Cloud Connect hostname (contract rule: a host is never both).
- **Publisher domain, two sources, no new setting.** Org form: the Worker's
  `MachineConfig.publisher_domain`, fetched by a signed W5 call off the runtime and cached
  per pairing for ten minutes (successes only). Direct form: the machine's existing
  `[cloud] app_callback_urls`, whose default is compiled from the repo-root
  `publisher.json`. Both sides derive the domain with the same rule. In this repository
  `publisher.json` holds the `<publisher-domain>` placeholder, so a build from it has no
  direct-link domain and **Copy phone link** refuses with a sentence on an unpaired
  machine. That is the intended honest state.
- **Order.** The org form wins when the org names a domain, wherever the page is open.
  Otherwise the direct form, if the request allows it. Otherwise 409 with every reason.
- **Where the link is built.** In the browser, with the shared `agentLinkUrl`, synchronously
  inside the click, because a clipboard write must happen within the gesture and over plain
  HTTP only the gesture-bound fallbacks exist. The server checks every target it hands out
  by building a probe link with the strict Rust twin.
- **No TUI counterpart.** The terminal UI gets no "Copy phone link" palette command and no
  machine code: it has no HTTPS request to prove a host from, and `yaran cloud pair-phone`
  still serves the org code there.

## 3. What each test proves

| Claim | Test | Result |
|---|---|---|
| A CLI-kind token sent as `yaran_session_<bound port>` authorizes HTTP, the events socket and a PTY socket under `require = "everywhere"`; without it the same requests and sockets are refused (401, 4401). | `a_cli_token_presented_as_the_session_cookie_is_a_session_everywhere` (`crates/yaran-web/tests/auth_router/phone.rs`, real loopback listener) | pass |
| `cli-logout` with the bearer ends the cookie session and closes its events and PTY sockets with 4401; the web's Sign out sent with the cookie ends the same session for the bearer too; a password change ends it. | same test | pass |
| `cookie_name` names the port the request arrived on, and `token` is still there. | same test (the real bound port) and `cli_login_names_the_cookie_of_the_port_it_arrived_on` | pass |
| As a cookie, a CLI token keeps the CLI idle limit: alive a day after a browser session idled out, gone after `cli_token_idle_days`. | `a_cli_token_in_the_cookie_idles_by_the_cli_limit` (`crates/yaran-web/src/auth/cli_cookie_tests.rs`, injected clock) | pass |
| The existing bearer path is unchanged. | `a_cli_token_authorizes_as_a_bearer_and_ends_on_logout_and_on_a_password_change` | pass |
| The two new routes need a session like every protected route. | `under_everywhere_every_protected_route_needs_a_session_and_the_public_ones_do_not` (routes added to the matrix) | pass |
| Plain HTTP with a forged `X-Forwarded-Proto: https` gets 409 `not_https`; a Funnel-marked request gets the code for its Host; the link target answers a target or `no_publisher_domain`, never an invented domain. | `the_machine_code_needs_a_transport_yaran_knows_is_https` | pass |
| Every add-machine and agent-link fixture row (build, bad domains, parse, parse without a domain) gives the TypeScript answer in Rust. | `cloud::protocol::links::tests::{add_machine_matches_the_fixture, agent_links_match_the_fixture}` | pass |
| The publisher-domain rule: one https `/auth/callback` host; none for disagreeing hosts, placeholders, ports, uppercase, other paths, http, userinfo or IPs. | `the_publisher_domain_is_the_one_callback_host` (Rust) and `derives the publisher domain by the rule yaran shares` (Worker), the same table | pass |
| `MachineConfig` with and without `publisher_domain` matches the schema; bad values are refused in both languages. | `machine_types_match_the_schema_fixtures`, `cloud/protocol` vitest | pass |
| W5 names the domain `APP_CALLBACK_URLS` implies, and omits the key (still schema-valid) when it implies none. | `names the publisher domain its APP_CALLBACK_URLS imply…` (`cloud/worker/test/machine-api/machine-routes.test.ts`) | pass |
| Machine code and link-target decisions: proven-HTTPS public host only, the Cloud Connect hostname refused, org form before direct, the direct form when the org is unreachable, both reasons when neither works, every target builds a valid link. | `crates/yaran-web/src/cloud_phone_links_tests.rs` | pass |
| The dialog shows both sections when paired, only the direct one when not, the server's sentence on refusal, and drops only the org section when pairing ends. | `components/ConnectPhoneDialog.test.tsx` | pass |
| Copy phone link builds the exact contract URL for an agent and a tab, copies inside the press and confirms, copies nothing and asks again on a refusal. | `lib/phoneLink.test.ts` | pass |
| Connect a phone is offered in a browser, paired or not, and never inside the app; the menu renderers still match the model. | `useAppMenuContext.test.ts`, `AppMenu.test.tsx`, `AppMenuSheet.test.tsx` | pass |

## 4. Checks run

- `cargo fmt --check`: clean.
- `cargo clippy --all-targets --all-features -- -D warnings`: clean.
- `cargo test` (workspace): see section 6.
- `cloud/protocol`: `npm run gen` (types and 147 fixture files), `gen:check`,
  `gen:vectors:check`, `vitest run` (14 files, 955 tests), `typecheck`, `lint:openapi`: pass.
- `cloud/worker`: `typecheck`, `lint`, `vitest run` (85 files, 1361 tests, 1 skipped) and
  `build` (`wrangler deploy --dry-run`): pass. `types:check` fails; see section 5.
- `crates/yaran-web/web`: `vitest run` (375 files, 6784 tests), `eslint .`, `npm run build`
  (`tsc -b && vite build`): pass.
- `website`: `vitest run` (16 files, 189 tests) and `astro build` (43 pages; the new anchors
  render): pass. The full `npm run build` was not run because its `prep` step fetches
  contributors from the network.
- `module-headers --check`: clean for every file this work touched. `--lines --check`: OK.

## 5. Environment findings (not caused by this work)

- `crates/yaran-web/web/node_modules` predated `@zxcvbn-ts/*` and
  `@xterm/addon-unicode11` in `package.json`, so 14 suites could not import. `npm ci`
  (lockfile-exact, no tracked file changed) fixed it.
- `cloud/worker/assets/console/tokens.css`, a gitignored copy, was older than
  `packages/ui-kit/src/tokens.css` from the HEAD commit. `npm run assets:ui-kit` refreshed it.
- `cloud/worker` `types:check` fails because the local, uncommitted `wrangler.jsonc` edits add
  a `yaran_cloud` D1 binding (with `"remote": true`) and change `APP_CALLBACK_URLS`.
  `worker-configuration.d.ts` was not regenerated, because it would commit those local edits
  into a tracked file.
- Because of that `"remote": true` binding, the Worker's workerd test pool opened a remote
  proxy session with the local Wrangler login (an auth-token refresh against Cloudflare).
  The tests use the local `DB` binding; nothing was deployed or written remotely, but the
  connection was made.
- `module-headers --check` reports drift in `mobile/**`, `cloud/protocol/src/index.ts` and
  `packages/ui-kit/src/inline-code.tsx` (Used by gains `deepLinks.test.ts`, `ScanQr.tsx` and
  `EnterUrl.tsx`), all from the mobile tracks' in-progress edits. Left to their owners.

## 6. Rust workspace test run

`cargo test` over the whole workspace (web UI built, `YARAN_DISABLE_UI_BUILD` unset): 95 test
binaries, every one `ok`; 9907 tests passed, 14 ignored, 0 failed.

## 7. Not proven, and limits

- **No live run.** No `tailscale serve` or Funnel request, no Cloud Connect tunnel, no real
  Worker W5 answer and no browser drove these routes; the HTTPS proof is exercised through
  the auth layer's own Funnel classification in tests.
- **Clipboard.** The copy runs inside the click through the shared `copyToClipboard` and its
  fallbacks; Safari's behaviour was not checked in a real browser. A refused copy shows the
  link in a toast to copy by hand.
- **The phone side is not here.** Native `directStatus`/`directSignIn`, the vault record, the
  cookie injection, the confirm screen, the `add-machine` and `/open` deep links and the
  App Link / associated-domain filters belong to tracks B, C, D and E. The consumer docs
  describe that flow as the contract specifies it.
- **Publisher infrastructure.** `assetlinks.json` and `apple-app-site-association` on
  `<publisher-domain>` must list `/open` before a phone verifies these links (T63).
- **Org cache.** A changed `APP_CALLBACK_URLS` reaches **Copy phone link** within ten minutes,
  or at once after a re-pair; a yaran restart also clears it.
- **Ambiguous callbacks.** A Worker or machine whose callbacks name two app domains makes no
  link at all, by design.

## 8. Sol review round: two P2 findings and their fixes

| # | Finding | Fix | Regression |
|---|---|---|---|
| S1 | `phoneLink.loadPhoneLinkTarget` kept a `ready` target for the life of the page. After a re-pair from A to B, or a domain change, opening the menu again fetched nothing and copied A's link. | `web/src/lib/phoneLink.ts` keeps a generation. `invalidatePhoneLinkTarget()` bumps it, forgets the target, and asks again at once when a menu offering the item is showing. `store.ts` calls it on `cloud.changed` and `config.changed`, the existing event path that already refreshes the bootstrap. A known target also expires after `TARGET_TTL_MS` (10 minutes). An answer to a question asked under an older generation is dropped. The copy stays synchronous inside the click. An expired target, or a menu state older than the page's current one, copies nothing: it says it is still asking and asks again, so no awaited fetch happens inside the gesture. | `phoneLink.test.ts` drives the real module state through the menu hook: an invalidation while the menu is open asks again, and the next copy uses B; a menu reopened after an invalidation fetches instead of reusing A; A's answer landing after an invalidation is dropped, and the copy uses B; an expired target copies nothing, asks again, and the next press copies the new answer. |
| S2 | `get_link_target` snapshotted pairing A, but `MachineApi::paired` read the credentials again, and W5 signs with whatever key the file holds when it is sent. A re-pair to B between the two reads cached B's publisher domain under A's key and returned it with A's org and machine. A cache hit could also answer after the pairing changed. | `cloud_phone_links.rs` `pairing_and_domain(read, fetch, cache)` takes one pairing snapshot, now including `paired_at` (as `made_at`), so a re-pair of the same machine id differs too. It asks W5 for exactly that snapshot's org with `MachineApi::new(&paired.org_url, …)`, then reads the credentials file again. Only an unchanged pairing is cached, keyed by the whole snapshot, or answered for. That covers cache hits as well. A change is retried once from the start; a second change is refused with "this machine's pairing changed while yaran was asking", which becomes the org sentence. `MachineApi` itself, its signing and its secret handling are unchanged, nothing new is logged, and no core helper was needed. | `cloud_phone_links_tests.rs` uses a scripted credentials reader and a counting W5, with no timing: A before W5 and B after it retries and answers only for B, with nothing cached under A; a pairing that keeps changing is refused in words, caches nothing, and gives no org link; a cache entry is never reused for a different pairing, or for a re-pair at a new time; a cache hit is not answered when the pairing moves before the reply; an unpaired machine asks nobody. |

Checks for this round:

- `cargo test -p yaran-web cloud_phone_links`: 11 passed (6 earlier and 5 new).
- `rustfmt --edition 2024 --check` on the two Rust files: clean. Only these two files were
  formatted.
- `cargo clippy -p yaran-web --all-targets --all-features -- -D warnings`: clean. Clippy
  rejected the first name for the new field, `paired_at`, so it is `made_at`.
- Web: `tsc -b`, and `eslint` on `phoneLink.ts`, `phoneLink.test.ts` and `store.ts`: clean.
  `vitest run src/lib/phoneLink.test.ts src/components` (133 files, 2779 tests) and the eight
  store test files that exercise `cloud.changed` and `config.changed` (9 files, 140 tests):
  all passed.
- The full 9907-test Rust run was not repeated; only the link-target route changed.

The "Org cache" limit in section 7 still holds for one case. A change to the org Worker's
`APP_CALLBACK_URLS` reaches **Copy phone link** within ten minutes, because the server's
cache has that lifetime and no event tells the machine. A re-pair, and a change to this
machine's own config, are seen at once on both the server and the page.
- Reconnect (P2, round 3): the events-socket reconnect recovery in `store.ts` now calls `invalidatePhoneLinkTarget()` beside `loadBootstrap()`, so a re-pair whose `cloud.changed` was missed during an outage no longer leaves **Copy phone link** copying the old target; `storePhoneLinkReconnect.test.ts` (real store and phoneLink, the new answer held back) copies B and never A, and fails with the line removed. Store, phoneLink and app-menu tests (36 files, 637 tests), `tsc` and `eslint` on the two files: clean.

## 9. Re-review P2: the reconnect identity window

**Finding.** The phone-link target was invalidated inside `recover()`, which runs only after a
reconnect's `/api/v1/build` identity check answers. Reproduced against the source:
1. A target for A is cached.
2. The socket drops, and the machine is re-paired to B; its `cloud.changed` is missed.
3. The socket reconnects while the build read is still out.
4. The offline overlay clears, and A is still fresh and copyable, from the open menu or a
   reopened one.

**Fix.** `phoneLink.ts` gains `pausePhoneLinkTarget()` and `resumePhoneLinkTarget()`, a flag
in the existing module rather than a new cache.
- The `eventsSocket.onOpen` reconnect branch in `store.ts` calls `pausePhoneLinkTarget()`
  synchronously, before the identity probe. Pausing invalidates the cached target and drops
  any answer already on its way (the generation moves).
- While paused, `loadPhoneLinkTarget` asks nothing. That covers a menu mounted during the
  gate and a `cloud.changed` or `config.changed` replayed during it.
- A stale press copies nothing, because its menu state is no longer the page's.
- `recover()` now calls `resumePhoneLinkTarget()` instead of invalidating. Recovery still runs
  only through the existing identity policy: a different run or a different yaran reloads or
  covers the page as before, and then the target stays paused.
- `store.ts` stays within its line baseline of 10465.

**Proof.**
- `storePhoneLinkReconnect.test.ts` gains a gated case using the real store and the real
  phone-link module: the page knows its yaran, so the reconnect waits on a held
  `/api/v1/build`. While it waits:
  - the open menu is no longer ready
  - a press from the menu that showed A copies nothing, and neither does a press from the
    current state
  - a newly mounted menu asks nothing, and neither does a `cloud.changed` invalidation
  - no link-target request is sent at all

  After the same run answers, exactly one fresh request goes out and the next press copies B,
  never A.
- The earlier reconnect case (identity unknown, so no gate) still passes.
- Mutation checks, each restored and compared afterwards: removing the pause at reconnect
  start fails the gated case, and letting a paused load still ask fails it too.

**Checks.**
- Web: `tsc -b`, and `eslint` on `phoneLink.ts`, `store.ts` and both phone-link tests: clean.
- `vitest run src/lib`: 229 files, 3887 tests passed.
- Module-header `--check` and `--lines --check` on the four web files, including the
  untracked test through a temporary index: OK.
