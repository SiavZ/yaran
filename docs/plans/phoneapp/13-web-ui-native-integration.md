# Phase 13 — Web UI: native-shell integration and Access-session UX

**Track:** B (web UI) · **Parallel-safe with:** 04–12, 14–18
**Depends on:** 02 (UA token parser `ua.ts`/`ua.rs`, `yaranapp://` control URLs, QR URI `add_org_uri`, `registry/refusals.json`, `registry/close-codes.json`), 03 (G1, G3, G12), 09 (QR SVG renderer), 10 (bootstrap `cloud` projection), 11 (`Yaran-Refusal`, close code 4401, `/__yaran/signed-in`), 14 (`@yaran/ui-kit` extraction, R18) · **Blocks:** 15 (the shell link contract in Design §11), 19

## Goal

The yaran web UI, served by the machine (D10) and loaded either in a browser or inside the
app's `machine-view` (D9), has to:

- tell "your Cloudflare Access sign-in expired" apart from "the server is down", and offer the
  right way back on each surface without a page reload;
- stop turning login pages into error toasts;
- recognise the native shell from its User-Agent token alone, since there is no JS bridge (D9);
- give the native shell its own entries (Switch machine, Phone app settings) in the one app
  menu;
- let a paired machine show the phone QR code;
- label the app correctly on the take-over card;
- fix the two connection-lifecycle gaps that hurt phones the most (`freeze`/`resume`
  listeners, and no beat on the events socket).

Every change follows the CLAUDE.md web tenets cited inline.

## Evidence

All paths are under `crates/yaran-web/web/` unless they start with `crates/`. Lines were
re-verified on 2026-11-14.

**Fetch handling** (`src/lib/jsonRequest.ts`, 76 lines):
- `request` (`:44-75`) uses `credentials: "same-origin"` (`:65`). A thrown fetch becomes
  "Could not reach the server." with status 0 (`:69-71`).
- `responseError` (`:17-24`) uses the whole trimmed body as the message with **no length cap**.
- `parseJsonResponse` (`:26-36`) returns `undefined` for 204 (`:27`), for an empty body
  (`:30`), and **silently for a non-JSON 200** (`:33-35`).
- Callers live only in `terminalsApi.ts:26`, `tabsApi.ts:34`, `sessionsApi.ts:107` and
  `projectsApi.ts:37`. The `request<void>` calls and `tabsApi.ts:52` (read as
  `closed?.promoted` at `store.ts:3658`) depend on `undefined` for 204 or empty bodies only.

**Offline overlay** (`src/components/OfflineOverlay.tsx`, 202 lines):
- It renders `open={offline}` (`:137`) as `role="alertdialog"` (`:145`) and cannot be dismissed.
- It has three faces from `copyFor` (`:79-125`): `given_up`, `connecting`, and waiting.
- The button calls `reconnect` (`:194`), which is `store.ts:5717-5727`.

**Sockets:**
- `reconnectingSocket.ts` (551 lines) exposes `connect` (`:129`), `resumeNow` (`:157`) and
  `dropForRetry` (`:197`).
  - Failures are counted at `:299`, and healthy resets at `:517-520`.
  - `shouldReconnect` defaults to true (`:541-544`).
  - Wake signals are at `:461-464`.
- `eventsSocket.ts` (94 lines) has **no special close codes and no receive deadline**.
- The server's 30 s events "ping" is a **WebSocket control Ping** (`server.rs:2800, 3471`;
  period `:246`), which JS never sees. Nothing on the events socket detects a half-open
  connection.
- `ptySocket.ts` (468 lines): close code 4001 at `:41` and `:363-379`; the beat frame at
  `:447-453`.
- `heartbeat.ts` (246 lines): `createHeartbeat` (`:82`), visible-time deadline, `onStalled`
  (`:164-174`). `visibleClock.ts` exposes `createVisibleClock` (`:61`).
- `src/lib/pageLifecycle.ts` attaches all four lifecycle events to `window` (`:103`), and its
  test dispatches on `window` (`pageLifecycle.test.ts:58-61`).

**Server identity:**
- `buildApi.ts:20-35` returns `null` on anything odd.
- Behind an expired Access session the 5 s re-ask (`store.ts:1185-1197, 1246-1250`) never
  resolves and nothing tells the user.
- `reloadPage.ts:11-14`.

**Store** (`src/lib/store.ts`, **6335 lines**, wiring only):
- The events URL is built at `:1069-1084`; `boot()` is at `:2042`.
- Connection fields: `conn` `:304`, `offline` `:309`, `reconnectPlan` `:314`.
- Handlers: `onConn` `:1952-1986`, `onOpen` `:1259`.
- Bootstrap: `bootstrap` `:300`, `applyBootstrap` `:1432`.
- Dialog flags follow the `taskManagerOpen` pattern: `:543`, default `:976`, open/close
  `:6022-6028`.

**Bootstrap type** (`src/lib/bootstrapApi.ts:14-188`):
- It is flat, with no `capabilities` object, and is cast without normalisation (`:263`).
- House rule (`:11-13`): optional field, documented default, consumers use `?? default`.

**Notifications** (`src/lib/notify.ts`, 214 lines):
- No action buttons. `NotifyOptions` has only `id` and `sticky` (`:57-65`).
- The boundary allowlist is at `notifyBoundary.test.ts:51`.

**`index.html`:**
- `:6` reads `<link rel="manifest" href="/manifest.webmanifest" />` with no `crossorigin`.
- `viewportMeta.test.ts:25-34` reads the file the way a new head test would.

**App menu** (`src/lib/appMenu.ts`, 278 lines):
- `AppMenuContext` (`:76-84`) has only `ghAvailable` and `githubIntegrationEnabled`.
- The model (`:91-264`) carries a doc comment saying not to gate on context without a real
  reason (`:86-90`).
- The context is built twice: `AppMenu.tsx:64-71` (`AppMenuBody`, rendered by
  `AppMenu.tsx:94`, `PaneMenu.tsx:194` and `TheaterPill.tsx:507`) and `AppMenuSheet.tsx:152-157`.
- Tests pin top-level order (`appMenu.test.ts:61-80`) and the trailing-ellipsis list
  (`:172-204`). They also check icons (`:206`), unique ids (`:261`), run routing (`:266-307`)
  and the store mocks (`:19-34`, plus `appMenuBindings.test.tsx:10-22`). Order is also pinned
  in `AppMenu.test.tsx:106`, `AppMenuSheet.test.tsx:55` and `TheaterPill.test.tsx:270`.

**Dialogs:**
- The simplest read-only template is `components/ProjectInfoDialog.tsx` (117 lines), using
  `ui/dialog.tsx`, `InfoRow` and `InlineCode` (`components/ui/inline-code.tsx`).
- Dialogs are mounted in `src/App.tsx:101-104`.
- The chip guard `components/dialogNameChips.test.ts` scans `*Dialog*.tsx` (`:24-42`) and flags
  quote-before-interpolation and font-mono spans (`:57-60`).
- There is no QR library and no `innerHTML` in `src/`. The SVG precedent is a data URI in
  `<img>` (`lib/favicon.ts:75-82`).
- Phase 14 work item 1 moves `components/ui/*` (dialog, inline-code, button and the rest) and
  the tokens into `packages/ui-kit/` (`@yaran/ui-kit`, exports `./*` → `./src/*.tsx`), with a
  one-shot import codemod. Paths above are today's; after that move they read
  `@yaran/ui-kit/dialog`, `@yaran/ui-kit/inline-code`, and so on.

**Device labels:**
- `src/lib/deviceLabel.ts` (56 lines) checks OS then browser (`:11-30`).
- `crates/yaran-core/src/device_label.rs` (278 lines) hand-copies the 11 web fixtures
  (`:134-166`) and checks them in `the_web_fixtures_produce_the_same_labels_here` (`:168`).
  No shared fixture file exists. The precedent is `crates/yaran-core/tests/fixtures/prose_cross_language.json`.
- Today an iPad WKWebView labels as "macOS" and an iPhone WKWebView as just "iOS" (R2 §5).

**New-window sites:**
- Same-origin standalone editor (`standaloneEditorHash`, `store.ts:2425`):
  `ChangedFiles.tsx:534, 771`, `AgentActionsMenu.tsx:224`, `EditorBody.tsx:1336`,
  `TerminalActionsMenu.tsx:61`.
- External: `MobileShell.tsx:369`, `FlatAgentList.tsx:415`, `PrBanner.tsx:28`,
  `DormantTabCard.tsx:75`, `DormantTabSurface.tsx:48`, `ConfirmCloseTabDialog.tsx:87`,
  `FirstLoadDialog.tsx:288`, `MarkdownPreview.tsx:68`, `terminal/linkPress.ts:88`.

**Notification API:** guarded by `typeof Notification === "undefined"`
(`agentNotifications.ts:133`), and `NotificationPermissionRow` hides when the API is absent
(`CustomizeWebappDialog.tsx:300-305`). Both are already inert in a WebView.

**Cloudflare Access behaviour** (fetched 2026-11-14):
- **Expired session plus `X-Requested-With: XMLHttpRequest`:** Access answers **401**
  ([session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/),
  Nov 10, 2026). Whether a request with no cookie at all gets 401 is UNVERIFIED (G3).
- **Navigation:** 302 to the team login.
- **`fetch` with default `redirect` following:** a cross-origin redirect gives a TypeError.
- **`redirect: "manual"`:** the response has type `opaqueredirect` and status 0
  ([WHATWG fetch](https://fetch.spec.whatwg.org/), Oct 19, 2026;
  [MDN Response.type](https://developer.mozilla.org/en-US/docs/Web/API/Response/type)).
- **A refused WebSocket upgrade:** only a close event, with no status
  ([WebSockets spec](https://websockets.spec.whatwg.org/), Nov 12, 2026).
- **cloudflared with a bad JWT:** answers 502, the same status as an unreachable origin
  (Phase 11 Evidence).
- **Manifest:** without `crossorigin="use-credentials"` the browser fetches it without
  credentials, so Access redirects it. This is the standard Access PWA caveat and is
  UNVERIFIED on device (R2 §4).

**Research:** `research/R2-web-frontend.md` §4–§8 and its Implications 3–9.

## In scope

- Native-shell detection.
- The Access-session state machine and probe, and the sign-in face in the offline overlay.
- `jsonRequest` hardening.
- The manifest `crossorigin` attribute.
- Native app-menu entries and "Connect a phone…" with its QR dialog (including the small
  yaran-web route that serves the SVG).
- The UA-token device label on both Rust and web, through a shared fixture.
- The `freeze`/`resume` listener fix.
- An application-level beat on the events socket (client and server).
- 4401 handling on both socket kinds.
- The web side of the shell link contract.
- Guard and unit tests for all of the above.

## Out of scope

| Item | Owner |
|---|---|
| `Yaran-Refusal`, 4401 server side, `/__yaran/signed-in`, `/__yaran/handoff` | 11 |
| The bootstrap `cloud` projection itself, cloud mode Preferences row, serving-crumb/TUI work | 10 |
| QR encoding crate and terminal rendering; the TUI palette "pair phone" command; any web "connect this machine" login/logout entries, including the machine key fingerprint chip on them (02 §7.1) | 09 |
| `packages/ui-kit/` itself, its tokens and the web's migration onto it | 14 |
| `machine-view` interception of `yaranapp://`, new-window and external-link handling, cookie renewal | 15 |
| Push notifications (native only; the web keeps "nothing raises one for attention") | 12, 16 |
| Docs and screenshots | 17 |

## Design

### 1. Native-shell detection (`src/lib/native/nativeShell.ts`)

- The token is Phase 02's (§11): `YaranApp/<major>.<minor>.<patch>[-<pre>] (<android|ios>;
  <phone|tablet>)`.
- There is no second parser. `parseNativeShell(ua): NativeShell | null` is a thin wrapper over
  Phase 02's `ua.ts` parser (which returns `{version, os, form}`), imported from
  `@yaran/protocol` through a `"@yaran/protocol": "file:../../../cloud/protocol"` dependency in
  `crates/yaran-web/web/package.json` (02 work item 1's consumer form). The Rust side uses
  `yaran_core::cloud::protocol::ua` (§9). One grammar, pinned by `cloud/protocol/fixtures/ua/`.
- `nativeShell()` memoises `parseNativeShell(navigator.userAgent)` once per page.
- No JS bridge is consulted (D9), and the browser build is unaffected because the token is
  absent there.
- `isNativeShell()` is the one predicate every other module uses.

### 2. Access-session state machine (`src/lib/native/accessSession.ts`)

**Why it exists:** today an expired Access session is indistinguishable from "server down".
The overlay counts attempts against a budget and gives up, and the identity re-ask loops
silently (R2 §5).

**State:** `"ok" | "probing" | "signin_needed"`. It is a module-level store with
`subscribe`/`getSnapshot` and a `useAccessSession()` hook (`useSyncExternalStore`). Keeping
it as a module adds no fields to `store.ts`; only the trigger calls touch it.

**Probe:**

```ts
fetch("/api/v1/build", {
  redirect: "manual",
  cache: "no-store",
  credentials: "same-origin",
  headers: { "X-Requested-With": "XMLHttpRequest" },
})
```

The response is classified by the pure function `classifyProbe(result)`. Its outcome type
`ProbeOutcome` is exhaustive, with `assertNever` (`00-CONVENTIONS.md` §1.5).

Rows are checked top to bottom, and the first match decides. `Yaran-Refusal` codes are Phase
02's (§13, `registry/refusals.json`); the outcome carries the code verbatim as `refusal` (for
the overlay's wording and the log), so no second name for a refusal exists in the web.

| Observation | Outcome |
|---|---|
| `type === "opaqueredirect"` | `signin_needed` (no session: 302 to login) |
| `Yaran-Refusal: access-keys-unavailable` (exact match, checked before the `access-` prefix) | `server_problem` with `refusal: "access-keys-unavailable"` (the overlay says yaran cannot reach Cloudflare's key service; signing in will not help) |
| `Yaran-Refusal: access-*` (any other of the 12 JWT refusals) | `signin_needed` with that `refusal` |
| `Yaran-Refusal: host-not-served` or `host-missing` | `server_problem` with that `refusal` (this machine is no longer connected to the cloud) |
| `Yaran-Refusal` with a code the registry does not hold | falls back to the status (02 §13): the rows below, as if the header were absent |
| 401 or 403 **without** a `Yaran-Refusal` header | `signin_needed` (Access answered) |
| 200 with JSON `{version, process}` | `ok` (the failure is the network or the server) |
| 200 that is not JSON | `signin_needed` (an HTML interstitial; G3 confirms) |
| 502, 5xx, TypeError | `unreachable` (cloudflared's 502 is ambiguous with origin-down, so it is never read as auth) |

The phase-local outcome and state names (`ok`, `probing`, `signin_needed`, `signin_maybe`,
`server_problem`, `unreachable`) are not registry codes (02 §4 says so), and none of them
reuses a refusal code's spelling.

**Triggers:**
- (a) `onConn` reports a failed attempt (one call at `store.ts:1952-1986`).
- (b) `jsonRequest` gets a TypeError, a 401/403, or an HTML or non-JSON body (§3).
- (c) Either socket closes with **4401** (§4).
- (d) A wake signal while in `signin_needed`.

Probes coalesce: at most one is in flight, with a 2 s minimum gap. While in `signin_needed`, the
module re-probes every 5 s of **visible** time, using `createVisibleClock`. That follows the
existing identity re-ask cadence (`IDENTITY_REPROBE_MS = 5000`, `store.ts:1185`) and the
visible-time tenet.

**Return to `ok`:** the module calls `eventsSocket.resumeNow()`, which refills a spent budget
and never touches a live socket (`reconnectingSocket.ts:157`). This is a sign-in being
recognised, not a silent retry under a "gave up" message: the overlay told the user it is
waiting for them to sign in (tenet: "a page that has said it gave up must not be quietly
retrying underneath").

**G3 fallback (fully designed):**
- If G3 shows that Access gives neither 401 nor an `opaqueredirect` that fetch can observe
  (for example, every case surfaces as a TypeError), `classifyProbe` cannot separate "expired"
  from "offline".
- In that case, on a page whose `location.hostname` equals `bootstrap.cloud?.hostname`, after
  3 consecutive `unreachable` probes while `navigator.onLine` is true, the state becomes
  `signin_maybe`.
- The overlay then shows a combined face with **both** "Reconnect" and "Sign in". Both actions
  are safe whichever cause is real.
- `ProbeOutcome` already reserves the variant, so adopting the fallback is a constant change
  plus a test.

### 3. `jsonRequest` hardening (touch `src/lib/jsonRequest.ts`; helper `src/lib/httpBody.ts`)

- Every request sends `X-Requested-With: XMLHttpRequest`. It is same-origin, so it costs no
  preflight, and Access then answers an expired session with 401 instead of a redirect fetch
  cannot follow.
- `responseError` stays the existing function and calls `describeErrorBody(status, contentType,
  body)` from the new `httpBody.ts`. That helper is pure and testable, and the
  `jsonRequest.ts` change stays small.
  - **HTML body** (`text/html`, or the body starts with `<`): the message becomes "The server
    answered HTTP *N* with a web page instead of a yaran reply. If you reach this machine
    through Cloudflare Access, your sign-in may have expired." It also triggers a probe.
  - **Any other body:** capped at 300 code points with "…" (char-safe, per the CLAUDE.md rule
    against byte slicing).
- `parseJsonResponse`: a non-empty 200 body that is not JSON now **throws**
  `createError("The server sent something yaran could not read (HTTP 200, not JSON)…", 200, "")`
  and triggers a probe. 204 and empty bodies still give `undefined`, so every `request<void>`
  caller is unchanged.
- The direct `resp.json()` fetchers (`bootstrapApi.ts:263` and the rest) already throw on HTML.
  Their failures happen during socket reopen, which triggers the probe through (a), so they are
  left alone.

### 4. Close code 4401 (touch `eventsSocket.ts`, `ptySocket.ts`)

- **`eventsSocket`:** a `shouldReconnect` override (the hook at `reconnectingSocket.ts:282`)
  returns true for 4401 and calls `accessSession.noteSessionExpired()`.
- **`ptySocket`:** 4401 joins the `shouldReconnect` switch (`:363-379`) as an ordinary retry.
  It is **not** `onGone` and **not** the 4001 stop. It still obeys the existing gate
  (`serverValidated() && !appSocketGivenUp()`).
- A shell that renewed its cookie early (Phase 15) therefore reconnects transparently and
  replays. A browser with an expired cookie lands on the sign-in face.
- The constant `ACCESS_SESSION_EXPIRED_CLOSE = 4401` mirrors Phase 02's
  `SESSION_EXPIRED_CLOSE_CODE` (`yaran_core::cloud::protocol`, `signals.rs`), which Phase 11
  sends. A test reads `cloud/protocol/registry/close-codes.json` (02 §13) with `readFileSync`,
  the way `prose.test.tsx:74-80` reads its shared fixture, and asserts that 4401 carries the
  reason `access session expired` and that the existing 4001 (`ptySocket.ts:41`) matches its
  registry row, so neither can drift.

### 5. Sign-in face (touch `src/components/OfflineOverlay.tsx`, 202 lines; stays under 500)

**When it shows:** the overlay opens when `offline || accessSession !== "ok"`. A fourth face,
`signin`, takes precedence over the reconnect faces. Its body is built as prose segments, with
the host as an `InlineCode` chip (tenet: "A name in a modal is a chip, never a quotation").
"Cloudflare Access" is named only when `location.hostname === bootstrap?.cloud?.hostname`;
otherwise the copy says "your sign-in".

**Browser:**
- Title: **Sign in again**.
- Body: "Your sign-in for `host` has expired, so yaran can't reach this machine. Sign in in a
  new tab, then come back here. yaran reconnects on its own."
- Button **Sign in** runs `window.open(new URL("/__yaran/signed-in", location.origin), "_blank",
  "noopener")` from the click, so popup blockers allow it.
- **No reload:** CLAUDE.md allows only the server-run-change reload, and a reload would also
  throw away the page's in-memory state. Access intercepts the new tab's navigation, the user
  signs in there, and the original tab's probe sees `ok`.

**Native** (`isNativeShell()`):
- Title: **Sign in again**.
- Body: "Your sign-in for `host` has expired. Sign in again to keep working; yaran picks up
  where it left off."
- Button **Sign in** runs `location.assign(reauthUrl(location.hostname))`, which is
  `yaranapp://reauth?host=<host>` (Phase 02 §10; `host` is a `Hostname`, so `hostname`, never
  `host` with a port). It stays on the custom scheme in every build: it never leaves the app's
  own WebView, because `machine-view` intercepts it before navigation, and machine-view honours
  it only when `host` is the host loaded (R2). `machine-view` runs the sealed handoff, which
  shows the consent page in the system browser (Phase 11), and injects the new cookie
  (Phase 15). The probe re-check then resumes the socket.

**`server_problem` face:** says which problem it is, chosen by an exhaustive switch on the
outcome's `refusal` (`access-keys-unavailable`: keys unavailable; `host-not-served` or
`host-missing`: the machine is no longer connected to the cloud), and offers "Reconnect".

**Shared components (R18):** the overlay, its buttons and the chips come from
`@yaran/ui-kit` (`dialog`, `button`, `inline-code`) once Phase 14's extraction lands, and from
today's `components/ui/*` until then (14's codemod rewrites the imports). No new component
or token is created here; a token this phase needed would go into
`packages/ui-kit/src/tokens.css`, never into the web's own CSS.

**Touch targets:** buttons inherit the dialog footer floor `max-md:[&_button]:min-h-11`
(`ui/dialog.tsx:141-144`), which meets the 40px tenet. The overlay remains a non-dismissable
alertdialog, so Escape abandons nothing.

**No toast on success:** the overlay closing and the live UI returning are "big and
unmistakable" (CLAUDE.md confirmation rule), so no success toast is raised and `notify.ts` is
untouched.

### 6. App menu: native entries and "Connect a phone…"

**Context:**
- `AppMenuContext` gains `nativeShell: boolean` and `phonePairing: boolean`. The latter is
  `bootstrap?.cloud?.paired === true && !nativeShell`, because a phone that is already in the
  app needs no QR.
- These are real reasons to gate, as the doc comment at `appMenu.ts:86-90` requires.
- Building the context moves into a new hook `useAppMenuContext()`
  (`src/lib/useAppMenuContext.ts`), which both `AppMenu.tsx:64-71` and `AppMenuSheet.tsx:152-157`
  call. The four-field object is then never built twice (`00-CONVENTIONS.md` §1.2, extract
  before duplicating).

**New entries**, in a new group placed between `task-manager` and `sep-about`:

| id | Title | Icon (lucide) | Shown when | Action |
|---|---|---|---|---|
| `connect-phone` | Connect a phone… | `Smartphone` | `phonePairing` | `openConnectPhone()` (dialog, so it has the trailing `…`) |
| `switch-machine` | Switch machine | `ArrowLeftRight` | `nativeShell` | `location.assign(HOME_URL)` (`yaranapp://home`) |
| `phone-app-settings` | Phone app settings | `Settings2` | `nativeShell` | `location.assign(SETTINGS_URL)` (`yaranapp://settings`) |

`yaranapp://home` and `yaranapp://settings` are Phase 02 §10 in-WebView control URLs and stay
on the custom scheme in every build, release included (R2): machine-view intercepts them before
navigation, so they never leave the app's own WebView.

- The group separator renders only when the group is non-empty (tenet: "compute the items,
  then decide").
- The guidance draft named the native items with a trailing `…`. They navigate to a native
  screen and open no dialog, so they carry **no ellipsis**, per the tenet "a trailing `…`
  marks any item that opens a dialog or needs confirmation". This is the plan-wide rule (R19):
  any phase quoting these labels writes "Switch machine" and "Phone app settings" exactly.

**Placement:** these are app-level actions, so they go in the cog menu (tenet: "Settings live
in exactly one place"; menus carry actions). Because `AppMenuBody` is also the Settings drill in
`PaneMenu` and `TheaterPill`, they stay reachable in theater mode and on phone pane screens,
which is the drill's purpose.

**Surfaces:** these are web-only entries.
- The TUI palette equivalent of "Connect a phone" is Phase 09's `pair-phone`.
- The native entries deliberately have no TUI counterpart, since the TUI never runs inside the
  app.
- This decision is stated here per CLAUDE.md "keep the two surfaces in step by hand".

### 7. Connect-a-phone dialog

- **Store wiring** (minimal, `store.ts`): a `connectPhoneOpen` flag with `openConnectPhone()`
  and `closeConnectPhone()`, following the `taskManagerOpen` pattern (`:543, :976, :6022-6028`).
- **Component:** `src/components/ConnectPhoneDialog.tsx`, modelled on `ProjectInfoDialog.tsx`,
  mounted in `App.tsx:101-104`. Its dialog, button and chip come from `@yaran/ui-kit` (R18,
  §5 "Shared components"); the dialog adds no component of its own. On open it fetches `GET /api/v1/cloud/phone-qr` through the new
  `src/lib/cloudApi.ts`, which returns `{ url, svg }`.
- **Rendering:** the SVG is shown as `<img alt="QR code for the yaran app" src={"data:image/svg+xml," +
  encodeURIComponent(svg)}>`, following the `favicon.ts:75-82` precedent. There is no
  `innerHTML`, and the dialog builds no SVG markup, so the chip guard stays clean.
  - Minimum 224 px square on a white quiet zone, so it scans in dark mode. The quiet zone is
    drawn inside the SVG by the encoder, so no colour is hard-coded in the web's CSS.
  - Below it sits prose with the org URL as an `InlineCode` chip: "Open the yaran app on your
    phone and scan this, or type `org url` into it. You'll sign in with your organisation's
    single sign-on."
- **Family:** read-only (Report-like) with a footer Close button. No destructive act, so no
  confirmation.
- **Self-closing:** if `bootstrap.cloud.paired` turns false while the dialog is open, it closes
  itself and raises `notifyInfo` through `notify.ts`: "This machine is no longer connected to
  `org`, so there is no phone code to show. Connect it again with `yaran cloud login`." This
  follows the tenet "target-keyed dialogs close themselves when their entity vanishes", and a
  change that may sit outside the visible area must be confirmed.
- **Server route:** `crates/yaran-web/src/cloud_phone_routes.rs` (new, ≤150 lines, one
  `.merge` line in `server.rs`).
  - It returns `{url, svg}` built from Phase 09's credentials (`org_url`) and Phase 09's
    encoder (`yaran_core::cloud::qr`, required to expose an SVG renderer).
  - The payload is `yaranapp://add-org?u=<percent-encoded org url>`, built by Phase 02's
    `yaran_core::cloud::protocol::uri::add_org_uri` and pinned by `fixtures/uri/add-org.json`.
  - It answers 409 with a sentence when the machine is not paired.
  - One encoder serves the CLI, the TUI and the web, so the three QRs cannot differ.

### 8. Manifest credentials (touch `index.html:6`; create `src/lib/indexHead.test.ts`)

- The link becomes `<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials" />`,
  so Access-protected installs fetch it with the cookie.
- The new head test reads `index.html` the same way `viewportMeta.test.ts:25-28` does. It
  asserts exactly one manifest link, and that link carries `crossorigin="use-credentials"`.

### 9. Device label from the UA token

**Shared fixture:** create `crates/yaran-core/tests/fixtures/device_label_cross_language.json`
with `[{ua, label}]`.
- Move the existing 11 fixtures into it. This removes the hand copy at
  `device_label.rs:134-166` and `deviceLabel.test.ts:6-32`, following the house pattern of
  `prose_cross_language.json`.
- Add the app cases:

| UA token | Label |
|---|---|
| `YaranApp/1.2.0 (ios; phone)` | "yaran on iPhone" |
| `YaranApp/1.2.0 (ios; tablet)` | "yaran on iPad" (fixes today's "macOS") |
| `YaranApp/1.2.0 (android; phone)` | "yaran on Android phone" |
| `YaranApp/1.2.0 (android; tablet)` | "yaran on Android tablet" |
| Malformed token (including a 4-part version, which 02's grammar rejects) | Falls through to OS/browser detection |

The labels follow the existing "{Browser} on {OS}" shape and fit Phase 02's
`SHORT_LABEL_MAX_CHARS = 24` (02 §11). The earlier "yaran app on Android tablet" (27 chars)
would have failed the existing test that every recognised UA fits the line
(`device_label.rs:217-234`).

**Logic:** both `deviceLabel.ts` and `device_label.rs` check the token **before** OS
detection, because iPadOS WKWebView sends a Mac UA, and both get it from Phase 02's parser
(`ua.ts` / `cloud::protocol::ua`, §1) rather than a local regex. Both suites read the JSON. The
Rust side reads it with `include_str!` relative to the crate.

### 10. Lifecycle fixes

- **`freeze`/`resume`:** per the Page Lifecycle specification these fire at `document` and
  do not bubble. The implementer confirms this at <https://wicg.github.io/page-lifecycle/>
  first; it is UNVERIFIED in this plan.
- **Fix in `pageLifecycle.ts:103`:** keep `pagehide` and `pageshow` on `window`, and attach
  `freeze` and `resume` to `document`. The test now dispatches `freeze` and `resume` on
  `document` and asserts that a dispatch on `window` is **not** what the code relies on. This
  proves the finding with a failing test before the fix (CLAUDE.md debugging rule).
- **Events beat:** the events socket gains the same single client beat the PTY sockets use
  (tenet: "one periodic client frame carries … an application-level beat … there is never a
  second pinger", applied per socket).
  - Client (`eventsSocket.ts`): reuse `createHeartbeat` (`heartbeat.ts:82`) with
    `heartbeat_seconds` and its visible-time deadline, and send `{"beat":n}`. On stall, call
    `dropForRetry()` (`reconnectingSocket.ts:197`). Nothing is sent while hidden.
  - Server: the events client-frame parser in `EventsSocketLoop` (`server.rs:2769-2830`) accepts
    an optional `beat` alongside `subscribe`/`unsubscribe` and answers
    `{"event":"beat","n":n}`. The parse-and-echo logic lives in the new
    `crates/yaran-web/src/events_beat.rs`, and `server.rs` gains one match arm.
  - `routeEvent` (`store.ts:1135+`) gets a `beat` case that feeds the heartbeat.

### 11. Shell link contract (consumed by Phase 15; web side is unchanged on purpose)

The web keeps opening new surfaces exactly as it does today. `machine-view` implements these
rules, and Phase 15 pins them with tests:

1. **Same-host navigation in the main frame:** stays in the view (the URL is the source of
   truth, and Back moves through it).
2. **New-window requests** (`window.open`, `target="_blank"`, the standalone editor sites
   listed in Evidence) for the **same host:** load in place in the same `machine-view`
   (a history push; native Back returns), which is Phase 15's navigation policy and keeps
   Android's default `setSupportMultipleWindows(false)`. "The standalone editor tab shows only
   what it raised itself" stays true, because the editor is still a separate page load. Going
   Back reloads the workspace from its URL (the URL is the source of truth), its PTYs re-claim
   through the existing "navigating away and back" gesture, and editor drafts survive in the
   draft cache.
3. **Any other `http(s)` host** (PR links, docs, terminal OSC 8 links, markdown links): open
   in the system browser. They never load in the view.
4. **`yaranapp://` URLs:** intercepted as control URLs (`reauth`, `home`, `settings`) and never
   loaded.
5. **Anything else** (`javascript:`, `file:`, `data:` navigations, other custom schemes):
   refused.

No web change is needed for rules 2 and 3, and a web change there would fork the browser
behaviour.

## Work items

Every new file starts with the `00-CONVENTIONS.md` §2 header, with `Uses` / `Used by`
generated by `tools/module-headers`. New TypeScript files type-check under the existing
`tsconfig.app.json`, and new pure modules are written strict-clean.

1. **`src/lib/native/nativeShell.ts`** (create, ≤100) and **`package.json`** (touch: the
   `@yaran/protocol` `file:` dependency, §1). *Tests:* `nativeShell.test.ts` runs every case in
   `cloud/protocol/fixtures/ua/` and also covers valid tokens for every platform and form
   factor, a version with 4 parts (rejected, per 02's grammar), malformed or injected tokens
   (extra parentheses, unknown platform), and the token appearing mid-UA.
2. **`src/lib/native/nativeNav.ts`** (create, ≤80). `reauthUrl(hostname)` percent-encodes the
   hostname, and `HOME_URL` and `SETTINGS_URL` are constants holding the Phase 02 §10 strings.
   *Tests:* hostname encoding, a page with a port still producing a port-free `host`, and the
   exact strings `yaranapp://reauth?host=…`, `yaranapp://home`, `yaranapp://settings`; every
   URL these builders produce is a case `cloud/protocol/fixtures/uri/control-urls.json`
   expects to be honoured.
3. **`src/lib/native/accessSession.ts`** (create, ≤300). It holds the state machine,
   `classifyProbe`, the coalesced probe, the visible-time re-probe, `useAccessSession`, and the
   `note*` triggers. *Tests:* `accessSession.test.ts` (Vitest, fake timers, stubbed fetch)
   covers:
   - every row of the §2 table;
   - every code in `cloud/protocol/registry/refusals.json` (read with `readFileSync`) maps to
     an outcome, `access-keys-unavailable` to `server_problem` despite its `access-` prefix,
     and the outcome's `refusal` equals the header code; an unknown code falls back to the
     status;
   - coalescing: 10 triggers give 1 fetch;
   - the re-probe pauses while hidden;
   - `ok` calls `resumeNow` exactly once;
   - the G3 fallback path to `signin_maybe`.
4. **`src/lib/httpBody.ts`** (create, ≤80) and **`jsonRequest.ts`** (touch). *Tests:*
   `httpBody.test.ts` (an HTML body, a 2 KB plain body capped by code points with an emoji at
   the boundary, an empty body) and `jsonRequest.test.ts` additions (the header is sent; a
   non-JSON 200 throws; 204 still gives `undefined`; a probe is triggered).
5. **4401 handling** (touch `eventsSocket.ts`, `ptySocket.ts`). *Tests:* events 4401 reconnects
   and notes expiry; PTY 4401 retries without `onGone`; the constant (and 4001) match
   `registry/close-codes.json`.
6. **`OfflineOverlay.tsx`** (touch). *Tests:* `OfflineOverlay.dom.test.tsx` covers:
   - the browser sign-in face opens `/__yaran/signed-in` in a new tab with `noopener`;
   - the native face navigates to `yaranapp://reauth?host=<location.hostname>`;
   - the host renders as `InlineCode`;
   - the Cloudflare wording appears only on the cloud hostname;
   - the `server_problem` face, with the right sentence for each of its three `refusal`
     codes;
   - the existing faces are unchanged.
7. **App menu:**
   - Create `src/lib/useAppMenuContext.ts` (≤50).
   - Touch `appMenu.ts` (context fields and the three entries), `AppMenu.tsx` and
     `AppMenuSheet.tsx` (call the hook).
   - Update tests: `appMenu.test.ts` (order with flags off and on; ellipsis list gains
     `connect-phone`; the native items are not in it; icons; routing; store mock),
     `appMenuBindings.test.tsx`, `AppMenu.test.tsx:106`, `AppMenuSheet.test.tsx:55` and
     `TheaterPill.test.tsx:270`.
8. **Connect a phone:**
   - Create `src/components/ConnectPhoneDialog.tsx` (≤180) and `src/lib/cloudApi.ts` (≤60).
   - Touch `store.ts` (flag and open/close) and `App.tsx` (mount).
   - Create `crates/yaran-web/src/cloud_phone_routes.rs` (≤150) and touch `server.rs` (merge).
   - *Tests:* a dialog dom test (fetch, `img` data URI, chip, self-closes plus `notifyInfo`
     when unpaired); the chip guard passes with no allowlist entry; Rust route tests (409
     unpaired; the payload equals `add_org_uri` for every case in `fixtures/uri/add-org.json`;
     SVG starts with `<svg`).
9. **Manifest:** touch `index.html` and create `src/lib/indexHead.test.ts` (≤40).
10. **Device label:**
    - Create the shared fixture JSON.
    - Touch `deviceLabel.ts`, `deviceLabel.test.ts` (read the JSON) and `device_label.rs`
      (token check plus reading the JSON; it stays under 500).
    - *Tests:* both suites run the same JSON. A Rust test asserts that no fixture label exceeds
      `SHORT_LABEL_MAX_CHARS` (24, as 02 §11 requires and the existing recognised-UA test at
      `device_label.rs:217-234` already enforces); a Vitest test asserts the same.
11. **Lifecycle:** touch `pageLifecycle.ts` and `pageLifecycle.test.ts` (failing test first).
12. **Events beat:**
    - Touch `eventsSocket.ts` and `store.ts` (`routeEvent` beat case, one line).
    - Create `crates/yaran-web/src/events_beat.rs` (≤120) and touch `server.rs` (one match
      arm).
    - *Tests:* Rust parse/echo unit tests plus an integration test (send `{"beat":7}`, receive
      `{"event":"beat","n":7}`; malformed beats are ignored, not fatal). Vitest: a stall after
      the deadline calls `dropForRetry`; no beats while hidden.
13. **Bootstrap type:** touch `bootstrapApi.ts` (`cloud?: {...}`) only if Phase 10 has not
    already added it. The fields consumed here are `paired`, `hostname` and `org_url`, and every
    consumer falls back with `?? default` (`bootstrapApi.ts:11-13`).
14. **Contract hand-off:** add the §11 link rules to Phase 15's test matrix (a cross-reference
    in this file is enough; Phase 15 owns the code).

## Acceptance

- [ ] In a browser on the cloud hostname with an expired Access session, the overlay shows
      **Sign in again** within one failed attempt, not "server may be down". Signing in, in the
      new tab, restores the original tab without a reload.
- [ ] Inside the app, the same condition navigates to `yaranapp://reauth?host=<host>`, and the
      page resumes once the probe sees `ok`.
- [ ] No HTML body ever reaches a toast. Error text is capped at 300 code points, and a
      non-JSON 200 is a failure.
- [ ] 4401 reconnects both socket kinds and never triggers the 4001 stop or `onGone`.
- [ ] Native entries appear only inside the app, and "Connect a phone…" only on a paired
      machine in a browser. Both reach the desktop flyout, the phone sheet and every Settings
      drill.
- [ ] The QR shown by the web scans to the same `yaranapp://add-org?u=…` the CLI and TUI show.
- [ ] The take-over card reads "yaran on iPad" for the app on an iPad, from one fixture both
      suites run, and every app label fits 24 characters.
- [ ] The probe classifier handles every code in `registry/refusals.json`, and the 4401
      constant matches `registry/close-codes.json` (tests read both files).
- [ ] New UI uses `@yaran/ui-kit` components and tokens only (R18); no colour is hard-coded.
- [ ] `freeze`/`resume` reach their handlers when dispatched on `document`.
- [ ] A half-open events socket is detected within the heartbeat deadline of visible time.
- [ ] `npm run lint`, `npm run build` and `npm run test` pass. The chip, notify-boundary and
      viewport guards pass unchanged.
- [ ] New files are ≤500 lines with generated headers. `store.ts` gained wiring only (field,
      open/close, trigger calls, beat route).

## Validation

```bash
cd crates/yaran-web/web
npm ci
npm run lint
npm run build        # tsc -b && vite build
npm run test -- src/lib/native src/lib/httpBody src/lib/jsonRequest \
  src/components/OfflineOverlay src/lib/appMenu src/components/AppMenu \
  src/components/AppMenuSheet src/components/TheaterPill src/components/ConnectPhoneDialog \
  src/lib/deviceLabel src/lib/pageLifecycle src/lib/indexHead src/lib/eventsSocket \
  src/components/dialogNameChips src/lib/notifyBoundary src/lib/viewportMeta
npm run test
cd ../../..
cargo test -p yaran-core device_label
cargo test -p yaran-web events_beat cloud_phone
cargo clippy --all-targets --all-features -- -D warnings
tools/module-headers/bin/module-headers --check
tools/preview-env/screens/reshoot.sh   # if any docs screenshot shows the app menu (Phase 17 owns new shots)
```

## Risks

| Risk | Mitigation |
|---|---|
| G3: Access answers expired fetches in a way fetch cannot observe (no 401, no `opaqueredirect`) | The fallback `signin_maybe` face with both actions is designed and tested in §2, and adopting it is a constant flip. |
| G1: cookie injection fails and Phase 15 moves to fallback L1 (sealed cookie value) or L2 (bearer through a loopback proxy) | The web is agnostic: it only reads probe outcomes and navigates to `yaranapp://reauth`. Nothing here depends on how the cookie got there. |
| Importing `@yaran/protocol` pulls `jose` or the schema validator into the web bundle | `nativeShell.ts` imports only the UA module, which has no runtime dependencies, and Vite tree-shakes the rest; the `npm run build` output is checked for `jose` once when the dependency lands. |
| G12: sockets survive expiry, or 4401 churns | 4401 handling is a plain retry. If Phase 11 turns closing off, the probe still catches expiry on the next fetch or reconnect. |
| A popup blocker refuses the sign-in tab | `window.open` runs synchronously inside the click handler. If it returns `null`, the face falls back to a visible link the user can press. |
| `X-Requested-With` changes behaviour at some proxy | It is same-origin with no CORS involvement, and yaran ignores it. A test pins that the server never reads it. |
| The UA token is spoofable by any browser | Labels and menu items only. Nothing security-relevant keys on it (the native items merely navigate to a scheme a browser cannot handle). |
| The events beat adds server work | One small frame per `heartbeat_seconds` (default 15) per visible tab, against the existing 32-socket cap. |
| The `freeze` fix changes behaviour on Chromium | The handlers are idempotent (`park`), and the visibility and focus wake signals still cover resume. |
| Menu-order tests in four files churn | They are listed explicitly in work item 7, so the churn is intended and reviewed. |
| A white QR quiet zone looks foreign in a dark-only UI | It is required for scanning. The surrounding chrome uses shadcn tokens; only the code image is fixed. |

## References

- `00-README.md` D8, D9, D10, D13; flows 3 and 4.
- `research/R2-web-frontend.md` §4, §5, §7, §8 and Implications 3, 4, 6, 7, 9.
- Phase 11 Design §2, §6, §7 (refusal header, 4401, signed-in route).
- `02-protocol-contract.md` §10 (control URLs, `add-org`), §11 (UA token, 24-char labels), §13
  (`Yaran-Refusal` codes, close codes, Y2); Phase 14 work item 1 (`@yaran/ui-kit`).
- Cloudflare session management (Nov 10, 2026); WHATWG fetch (Oct 19, 2026); WebSockets spec
  (Nov 12, 2026); MDN Response.type. All fetched 2026-11-14.
- CLAUDE.md web tenets cited inline: one top menu / Settings drill; actions collapse into `⋯`;
  `notify.ts` is the one raiser; names in modals are chips; 40px touch floor; the URL is the
  source of truth; the only reload is a server-run change; the app socket's budgeted
  reconnecting and visible-time clocks; destructive actions confirm; confirmation owed only
  when the screen cannot vouch.

## Reconciliation notes (2026-11-14)

- R18: Evidence notes Phase 14's move of `components/ui/*` into `@yaran/ui-kit`; §5 "Shared components", §7 and a new acceptance line require the overlay and Connect-a-phone dialog to use ui-kit components and tokens only; 14 added to Depends on and an Out of scope row; QR quiet zone stated as part of the SVG, so no hard-coded colour.
- R19: native items stay "Switch machine" and "Phone app settings" with no ellipsis; §6 states it is the plan-wide rule.
- R2: §5 and §6 state that `yaranapp://reauth?host=`, `yaranapp://home` and `yaranapp://settings` stay custom-scheme in every build (in-WebView control URLs); the menu actions use the `HOME_URL`/`SETTINGS_URL` constants.
- R9 / 02 §13: probe classifier rows reordered so `access-keys-unavailable` wins over the `access-` prefix, an unknown-code row falls back to the status, outcomes carry the refusal code verbatim as `refusal`; tests read `registry/refusals.json`; local state names confirmed distinct from registry codes.
- R9 / 02 §13: the 4401 constant is tested against `registry/close-codes.json` (Rust home is 02's `signals.rs`, not a Phase 11 constant).
- 02 §10: `reauthUrl` takes `location.hostname` (02's `Hostname`), not `location.host` with a port.
- 02 §11 / one home: `parseNativeShell` wraps 02's `ua.ts` (web gains a `@yaran/protocol` `file:` dependency; Rust uses `cloud::protocol::ua`); the local `\d+(\.\d+){0,3}` grammar removed and the 4-part-version test now expects rejection; bundle-size risk row added.
- 02 §11: app labels shortened to "yaran on iPhone/iPad/Android phone/Android tablet" to fit `SHORT_LABEL_MAX_CHARS = 24` (the old 26–27-char labels would fail `device_label.rs:217-234`); test and acceptance updated.
- 02 §10: the QR route uses `add_org_uri` and is tested over `fixtures/uri/add-org.json`.
- 02 §7.1: the fingerprint chip on web login surfaces assigned to 09 in Out of scope (13 builds no login surface).
- R20: Blocks line pointed at §7 for the shell contract; corrected to §11. G1 "rung" wording → 03's L1/L2.

### Straggler pass (2026-11-14)

- Design §11 rule 2: same-host new windows now load in place in the one `machine-view` (history push, Back returns), matching 15's navigation policy and acceptance; the stacked-view wording is gone. 15 owns machine-view navigation; this phase only states what the web asks for, and the web side is unchanged either way.
- Work item 2: `nativeNav.ts` tests also read 02's new `fixtures/uri/control-urls.json`.
