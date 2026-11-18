# R2: Web frontend and its serving (native app / Cloudflare Access / path-proxy planning)

Scope: `crates/yaran-web/web/` (React 19 + Vite 8 + Tailwind 4) and the Rust side that serves it (`crates/yaran-web/src/`).
Paths are relative to `crates/yaran-web/` unless they start `crates/`. Read-only research; four parallel Explore passes, then key claims spot-checked by hand (marked "verified").
UNVERIFIED = not confirmed in this repo (platform behavior, Cloudflare behavior, or not traced to the end).

---

## 1. Build and embedding

- `web/vite.config.ts:8` `base: "./"` (verified). Built `web/dist/index.html` therefore references `./favicon.png`, `./manifest.webmanifest`, `./assets/index-*.js` (crossorigin), modulepreloads and CSS, all relative.
- `build.rs`: reruns on changes to web/src, public, index.html, package.json, lockfile, vite/ts/eslint config, scripts, `src/compressible_exts.rs`, `build_compat.rs`, and the disable env vars (168-187, 242-244). Runs `npm ci` (falls back to `npm install`) when `node_modules/.package-lock.json` is stale (268-275, 373-386), then `npm run build` (276) = `tsc -b && vite build`; panics if `dist/index.html` is missing (279, 317-328).
- `YARAN_DISABLE_UI_BUILD` (non-empty) skips the build; `DUX_DISABLE_UI_BUILD` only when the new var is absent (`build_compat.rs:5-7`, `build.rs:307-312`). Existing dist is embedded as `stale` (340-349); otherwise a `NOT_BUILT_PAGE` placeholder (no `#root`, sentinel comment `yaran-ui-not-built-notice`) is written (113-157, 351-361). Runtime warns via `ui_build_warning`/`ui_startup_warning` (`src/web_assets.rs:84-104, 141-144`).
- Embedding: `rust-embed` 8 (`#[folder = "$OUT_DIR/ui"] struct WebAssets`, `src/web_assets.rs:31-33`). `build.rs::stage_dist` (433-440) mirrors dist to `$OUT_DIR/ui`, Brotli q11 for js/css/html/json/svg/webmanifest/txt/map (491-529; list `src/compressible_exts.rs:10-19`).
- Implication: a Capacitor build that bundles the UI would consume the same `dist/` (relative assets already). The binary is the only shipping vehicle today.

## 2. Serving (static handler, routes, headers, guards)

### Router (`src/server.rs:776-846`)
- WS: `/ws/events`, `/ws/sessions/{id}/pty`, `/ws/sessions/{id}/terminals/{tid}/pty`, `/ws/projects/{id}/terminals/{tid}/pty`, `/ws/terminals/{tid}/pty`, `/ws/sessions/{id}/tabs/{tab}/pty` (777-794).
- REST: everything under `/api/v1/*`, merged from ~17 modules (795-811). `/healthz` (813). Fallback `web_assets::static_handler` (814).
- Middleware, outermost first: Host allowlist (836-846, always active in prod, `src/lib.rs:500, 1406-1410`), access log (830), `rest_mutation_origin_check` (821).
- Full route table (abridged): bootstrap, build, resources, workspace/projects/sessions reads, session/project/tab/terminal CRUD and actions, git actions, editor file routes under three prefixes (`/api/v1/sessions/{id}/files`, `/api/v1/terminals/{tid}/files`, `/api/v1/projects/{pid}/terminals/{tid}/files`, with `raw` as GET), `/api/v1/file-drop` (POST, body limit), browse, config (`/config/settings` PATCH, `/config/raw`, toggles), first-load, release-notes. Sources: `file_routes.rs:349-395`, `git_routes.rs:89-105`, `config_routes.rs:30-70`, `session_actions.rs:63-95`, `file_drop_routes.rs:129`, `browse_routes.rs:37-39`, `first_load_routes.rs:87-88`, `startup_logs.rs:42-53`.

### Static / SPA fallback (`src/web_assets.rs`)
- `/` -> `index.html`; exact embedded path served (189-196). Miss under `assets/` -> 404 (201-203). Any other miss -> `index.html` as `text/html` (204-207), including misses under `/api/v1/...` (tested `server.rs:4082-4113`). Consequence for clients: an unknown API path returns 200 HTML, not 404 JSON.
- Cache: `assets/*` = `public, max-age=31536000, immutable`; everything else (index.html, sw.js, manifest, offline.html, icons) = `no-cache` (155-161; tests 517-530). Weak ETag from rust-embed sha256, 304 on `If-None-Match` (167-183, 213-232).
- Compression: `Vary: Accept-Encoding`; `Content-Encoding: br` when accepted, else decompressed on the fly (288-301). No gzip.

### Security headers
- None on app/static responses: no CSP, X-Frame-Options, Referrer-Policy, HSTS, Permissions-Policy. Only the raw worktree-file route sets `CSP: sandbox`, `nosniff`, `Content-Disposition: attachment`, `no-cache` (`src/file_routes.rs:652-662`).
- No CORS layer at all (no `cors`/`access-control` in src).
- Nothing reads `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Cf-Access-*`, `Cf-Connecting-*`. No auth gate by design (`src/server.rs:6-7, 588-591`).
- `/.well-known`: zero hits anywhere (Rust crate, web/src, web/public).

### Host allowlist (`src/host_guard.rs`)
- Normalises Host (port stripped, IPv6-aware, trailing dot, lowercase, 55-91); missing/malformed -> 403 (246-264).
- Allowed when (202-237): loopback/`localhost`; any IP literal when bound to `0.0.0.0`/`::`; IP literal equal to a bound IP; exact match in `[server] allowed_hosts` (no wildcard, 429-441); Tailscale CGNAT/ULA IP literal when tailscale mode != no.
- `allowed_hosts` is the only extension point, read at startup only; the web config editor refuses to change it (`src/engine_actor.rs:4025-4031`, verified).
- Doc drift: the config comment says "Extra Host header values to accept on NON-same-origin requests" (`crates/yaran-tui/src/config.rs:1104`); in fact any unlisted hostname is rejected outright.

### Origin check (`src/server.rs:914-956`, verified)
- `same_origin_allowed`: no Origin -> allowed. Otherwise `origin_host(Origin)` (scheme dropped, `null` or scheme-less -> None) must equal the RAW `Host` header string exactly (port included, no normalisation, case-sensitive).
- Applies to REST POST/PATCH/PUT/DELETE (970-980) and every WS upgrade (`/ws/events` 2587; pty 1281, 1338, 1395, 1453, 1562) -> 403 "cross-origin WebSocket upgrade rejected". GETs never Origin-checked.
- Scenarios:
  - Tunnel preserves Host `foo.example.com`, browser Origin `https://foo.example.com`: passes once `foo.example.com` is in `allowed_hosts`.
  - Tunnel rewrites Host to `localhost:PORT` (cloudflared `httpHostHeader`): Host guard passes (loopback), but Origin `foo.example.com` != `localhost:PORT` -> every mutation and WS upgrade 403. (cloudflared default UNVERIFIED; believed to preserve Host by default.)
  - Host arriving as `foo.example.com:443` vs Origin without port: mismatch (raw compare).
  - Worker path-proxy that rewrites Host to the machine hostname while the browser Origin is the org hostname: 403 on WS/mutations.
  - Bundled UI origins `capacitor://localhost` / `https://localhost` / `http://localhost`: authority `localhost` never equals a real Host -> 403; GETs reach the server but responses are unreadable cross-origin (no CORS).

## 3. Base-path compatibility (`/m/<machine>/`)

Verdict: does NOT work today. Assets load (relative) and the hash router never touches `pathname`, but every API fetch, every WS, the SW, the manifest and seven image/icon refs are root-absolute. No central URL helper; `import.meta.env.BASE_URL`/`document.baseURI` never used; no `<base>` tag.

| Place | file:line (web/) | Root-absolute? | Fix |
|---|---|---|---|
| Shared JSON wrapper (passes path through) | `src/lib/jsonRequest.ts:63` | via callers | none itself |
| Callers of it | `src/lib/sessionsApi.ts:144-251`, `projectsApi.ts:54-127`, `tabsApi.ts:45-77`, `terminalsApi.ts:35-66` | yes | `"/api/v1` -> `"api/v1` |
| Own wrappers | `src/lib/configApi.ts:18,39-149,84,135`; `browseApi.ts:9,25,47-55`; `fileApi.ts:118,155`; `git.ts:26,49,64` | yes | same |
| Direct fetches | `workspaceApi.ts:51`, `changesApi.ts:44-45`, `bootstrapApi.ts:251`, `resourcesApi.ts:58`, `buildApi.ts:22`, `firstLoadApi.ts:35,56`, `fileDropApi.ts:42` | yes | same |
| Editor roots (feeds `fileApi.fileUrl/rawUrl`, `markdownAssetUrl`, `<img src>` at `EditorBody.tsx:1941`, `MarkdownPreview.tsx:42`) | `src/lib/editorRoot.ts:70,71,79`; `fileApi.ts:166,202-203`; `markdown.ts:81` | yes | same, one file |
| Events WS `${wsScheme}//${location.host}/ws/events` (module load) | `src/lib/store.ts:1069-1083` (verified) | yes | `new URL("ws/events", location.href)` + protocol swap |
| PTY WS (5 kinds) | `src/lib/ptySocket.ts:46-48` (scheme), `:54,62,73,82,111` | yes | same helper |
| Logo `<img src="/yaran-logo.svg">` | `components/DormantTabCard.tsx:42`, `MobileShell.tsx:82`, `FirstLoadDialog.tsx:102,124`, `Welcome.tsx:80`, `Sidebar.tsx:455` | yes | `"yaran-logo.svg"` |
| Default favicon (also attention-dot compositing) | `src/lib/favicon.ts:19` (used 96,160-166,207,239; `CustomizeWebappDialog.tsx:58,119`) | yes | `"favicon.png"` |
| SW registration `register("/sw.js")` -> scope `/` | `src/lib/sw.ts:11` (verified) | yes | `register("sw.js")` (scope becomes prefix dir) |
| SW offline URL | `public/sw.js:12` `"/offline.html"` (verified) | yes | `"offline.html"` |
| Manifest `start_url "/"`, `scope "/"`, icons `/icon-*.png` | `public/manifest.webmanifest` (verified) | yes | `"./"`, relative icons |
| index.html icon/manifest | `index.html:5-6` | source yes, built no (vite rewrites) | none |
| CSS fonts, chunks | `src/index.css:16-86`, dist | no | none |
| Hash router: `parseRoute` `store.ts:2312`, `routeHash` 2350, `positionHash` 2357, `syncUrl` 2473 (only push/replaceState, 2488/2491), `historyUrlFor` 2509-2511 keeps `pathname+search` | no | none |
| Standalone editor tabs: `standaloneEditorHash` `store.ts:2425`; `window.open(...)` `ChangedFiles.tsx:771`; hrefs `ChangedFiles.tsx:533`, `AgentActionsMenu.tsx:223`, `TerminalActionsMenu.tsx:60`, `EditorBody.tsx:1332` | no (fragment-only) | none (but see §6 window.open in WebView) |
| Reloads: `reloadPage.ts:13`, `ChunkBoundary.tsx:47,60`, `offline.html:84` | no | none |
| `isLocalAccessHost(location.hostname)` gates "Open in editor" | `EditorBody.tsx:487`, `lib/localAccess.ts:10` | behavior only: disabled behind a public hostname (correct) | none |

- Change size: mechanical. ~16 files of `/api/v1` literals, 2 files of WS construction, 7 image/favicon refs, SW + manifest. Relative `fetch("api/v1/...")` is a drop-in at root. Hard requirement: the page URL must end in `/` (`/m/x` would resolve `api/...` to `/m/api/...`; built `./assets` already has the same requirement), so the proxy must 301 `/m/x` -> `/m/x/`.
- Test churn: 47 test files contain ~168 `/api/v1`/`/ws` literals; how many assert exact URLs is UNVERIFIED.
- Server Location headers on create (`session_actions.rs:421`, `project_actions.rs:189`) are root-absolute but unread by the UI.
- Rejected alternative: keep root paths and have the Worker route `/api` and `/ws` by cookie/Referer. Fragile with two machines in two tabs of one origin; and with a shared origin, one root-scoped SW and one `localStorage` would be shared across all machines (see §7 keys) unless the prefix scoping is real.

## 4. PWA

- `index.html` (source): `charset` (4); `<link rel="icon" href="/favicon.png">` (5); `<link rel="manifest" href="/manifest.webmanifest">` (6) with NO `crossorigin="use-credentials"`; `theme-color #0a0a0a` (7); viewport `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content` (15, pinned by `src/lib/viewportMeta.test.ts`); `<title>yaran</title>` (16); one module script (20); no inline scripts.
  - Behind Cloudflare Access the manifest request is a credentialed same-origin fetch only if `crossorigin="use-credentials"` is set; without it browsers fetch manifests in no-credentials mode, so Access answers with a login redirect and install/standalone metadata silently fails (standard Access PWA caveat; UNVERIFIED on device).
- `public/manifest.webmanifest`: name/short_name "yaran", description, `start_url "/"`, `scope "/"`, no `id`, `display "standalone"`, bg/theme `#0a0a0a`, icons `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png` (1-30).
- `public/sw.js`: cache `yaran-offline-v3` holding only `/offline.html` (11-12); install caches it (`cache:"reload"`) + unconditional `skipWaiting()` (14-23); activate deletes other caches + `clients.claim()` (25-34); fetch handles only `mode==="navigate"`: network, else cached offline page, else `Response.error()` (36-50). No precache/app shell, no push, notificationclick, message or sync handlers, no update prompt.
- `public/offline.html`: self-contained (inline CSS, base64 woff2), "yaran is unreachable", Retry via inline `onclick="location.reload()"` (84) (a future CSP without `unsafe-inline` would break it).
- Registration: `src/lib/sw.ts:5-15` (called `main.tsx:12`), after `load`, only when `isSecureContext`; errors swallowed.
- Note: behind Access, an expired session makes a navigation return a 302 to `*.cloudflareaccess.com`, not a network error, so the SW's offline fallback does not apply; the navigation goes to the login page (expected; UNVERIFIED in a WebView).

## 5. Connection lifecycle

### Events socket (`src/lib/reconnectingSocket.ts`, `eventsSocket.ts`, `store.ts`)
- URL from `location.protocol`/`location.host` (`store.ts:1069-1083`), connected in `boot()` (`store.ts:2042-2058`).
- Backoff 0.5 s doubling, capped at `reconnect_backoff_cap_seconds` (default 10) (`reconnectSchedule.ts:41-44`, `connectionTiming.ts:17`). Budget `reconnect_attempts` default 8, 0 = never stop (`connectionTiming.ts:21`); exhausted -> `givenUp`, `onConn("failed")` (`reconnectingSocket.ts:314-321`). Any close counts as a failure (541-544).
- Per-attempt deadline `reconnect_attempt_timeout_seconds` default 10 (385-395). Healthy = a frame or 2 s open, resets failure count (39, 258-263, 421-427).
- Wake signals: `visibilitychange` (to visible), `pageshow`, `focus`, `online` (461-464). `resumeNow()` refills a spent budget, never touches a live socket (157-185).
- UI: `components/OfflineOverlay.tsx` ("Not connected to yaran / yaran stopped trying after N attempts…" 80-88; "Attempt N of 8 failed. Retrying in X s… The server may be down or this device may be offline." 107-124). Button -> `reconnect()` (`store.ts:5717-5727`).
- Gap vs tenet: backoff and connect deadline are wall-clock (`Date.now()`), not visible-time; only replay wait (`TerminalPane.tsx:168-181`) and heartbeat (`heartbeat.ts:92`) use the visible clock.
- No app-level beat on the events socket (half-open detection relies on TCP). UNVERIFIED how long that takes after a radio handoff.

### PTY sockets (`src/lib/ptySocket.ts`, `components/terminal/useTerminalLifecycle.ts`, `ownership.ts`)
- `parkWhileHidden: true`, retries gated on `serverValidated() && !appSocketGivenUp()`, own budget 0 (`ptySocket.ts:149-158`). Hidden: no reconnect scheduled (`reconnectingSocket.ts:308`, 165). Stops for good on close 4001 or tab gone (`ptySocket.ts:363-379`).
- Take-over: intent armed then `pty.connect()` bounce (`ownership.ts:422-447`); spent only by an outgoing resize `{rows, cols, takeover:true[, expected_owner]}` (`useTerminalLifecycle.ts:240-255`, `ptySocket.ts:417-433`); cleared on any close (`ownership.ts:405-414`); plain bounces clear it (`plainBounce.ts:13-19`). Self-succession only with confirmed run + foreground + own ghost id (`ownership.ts:336-344`).
- Attach epoch / replay cover: `attach.noteOpen()` per open; cover clears only on `noteReplayApplied(epoch)` (`socketCallbacks.ts:84-97`, `useTerminalLifecycle.ts:328`).
- Beat/viewed frame `{"beat":N,"viewed":B}` -> `{"event":"beat","n":N}` (`ptySocket.ts:447-453`): 2 s while owner+visible (`viewedPing.ts:16`), else `heartbeat_seconds` default 15 (`heartbeat.ts:36-43`); 30 s visible-time deadline -> `dropForRetry()` plain reattach (`heartbeat.ts:159-170`). Nothing sent while hidden.

### Server-run identity
- Server: `GET /api/v1/build` -> `{version, process}`, process = per-run UUIDv4 (`src/build_routes.rs:46-61`).
- Client: `fetchServerIdentity()` (`cache:"no-store"`) returns null on non-2xx / JSON error / bad shape (`src/lib/buildApi.ts:20-35`); null on either side = not changed (40-48). Baseline at boot (`store.ts:1207-1215`); probe on every events reopen (1259-1272); changed -> `reloadPage()` disarms editor beforeunload guard then `location.reload()` (`reloadPage.ts:11-14`).
- Unknown: no reload, PTY gate opens anyway, `runConfirmed=false` (blocks ghost self-succession), re-asks every 5 s (`serverRun.ts:83-97`, `store.ts:1185-1197, 1246-1250`).
- Behind Access with an expired session, `/api/v1/build` gets a redirect/HTML -> null -> "unknown" forever; no reload, which would otherwise have been the only path to the login page.

### Device label
- Server stores raw `User-Agent` from the PTY WS upgrade, 200-char cap (`src/server.rs:210-220`, verified; used 1249, 1630); sent as `owner_device` in `connected` and `device` in `pty.owner` (`src/ownership_publish.rs:46-52`). Never parsed server-side; events socket does not record it.
- Client parses in `src/lib/deviceLabel.ts` -> "{Browser} on {OS}" or OS or null ("another device").
  - Android WebView UA (`; wv` … `Chrome/`) -> "Chrome on Android" (acceptable).
  - iPhone WKWebView (no `Safari/`) -> "iOS".
  - iPad WKWebView sends desktop Mac UA -> "macOS" (misleading).
  - App name never shown unless the shell appends a UA token (Capacitor `appendUserAgent`) and `deviceLabel.ts` learns it.

### Fetch error handling (relevant to Access)
- On load: `/ws/events`, `/api/v1/bootstrap`, `/api/v1/workspace`, `/api/v1/build` (`store.ts:2042-2054`); repeated on every events reopen (1272-1292).
- `fetchBootstrap`/`fetchWorkspace`: thrown fetch -> status 0 "Could not reach the server."; non-2xx throws with body text; then `resp.json()` (`bootstrapApi.ts:248-262`, `workspaceApi.ts:48-63`). Callers only `console.warn` (`store.ts:1415-1420, 1547-1552`); nothing on screen.
- `jsonRequest.ts`: catch -> "Could not reach the server." (verified 63-70); `!ok` -> `responseError` uses whole trimmed body as message (20-27), so a 401/403 HTML page becomes a toast of raw HTML (no length cap, `notify.ts:144`); `parseJsonResponse` returns `undefined` for non-JSON 200 (29-38), callers reading fields may throw (not traced per caller).
- Predicted behaviors (fetch semantics, UNVERIFIED against real Access):
  - 302 to `*.cloudflareaccess.com`: followed in `cors` mode, no CORS headers -> TypeError -> "Could not reach the server."; bootstrap silent; identity unknown.
  - HTML 200: JSON SyntaxError (bootstrap: console only; actions: `undefined`).
  - 401/403: raw body toast.
  - WS upgrade refused: browser surfaces `error` + `close 1006`, no status -> ordinary failure counted against the budget (`reconnectingSocket.ts:266-287, 299`). After ~36 s the overlay says the server may be down / device offline. Nothing anywhere distinguishes "auth expired".
- Same-origin assumptions: every fetch path-only with `credentials: "same-origin"` (e.g. `jsonRequest.ts:65`); only custom header `x-connection-id` (`jsonRequest.ts:53`); no Authorization header, no token, no query-param token on fetch or WS. `document.cookie` only for the sidebar-open preference (`store.ts:813, 834`; `components/ui/sidebar.tsx:89`). So the `CF_Authorization` cookie rides along automatically when page and API share an origin, and the UI needs nothing for Access in the "WebView loads the remote URL" model.

### Lifecycle handlers
- `src/lib/pageLifecycle.ts`: pagehide -> close; pageshow/resume -> reopen; freeze -> park (29-42); listeners attached on `window` (101-106, verified), used by events socket (`store.ts:1097`) and each PTY socket (`useTerminalLifecycle.ts:370`).
- Possible bug (UNVERIFIED): Chromium fires `freeze`/`resume` at `document` without bubbling, so `window` listeners likely never fire; the test dispatches on `window` (`pageLifecycle.test.ts:60`) and would not catch it. Impact is small (visibility/focus wake signals cover reopen; a stale connect deadline may count one spurious failure).
- `beforeunload` only for dirty editor buffers (`editorDrafts.ts:84-98`).

## 6. Attention / "needs you" and notifications

- Wire: no dedicated event. `needs_attention` rides inside the pushed workspace doc `{"event":"workspace","rev":N,"workspace":{…}}` (`src/server.rs:2271-2282`) -> `applyPushedWorkspace` (`store.ts:1149`); legacy `sessions.changed` -> refetch (1153-1155). Fields: `SessionView.needs_attention` (tab roll-up, `types.ts:187-190`), per-tab `needs_attention` (`types.ts:81-83`); missing -> false (`workspaceApi.ts:79-87, 185-187`).
- Rust: scanner `crates/yaran-core/src/attention.rs:1-25` (BEL, OSC 9, OSC 777; OSC 9;4 = progress); set `Engine.needs_attention: HashSet<TabId>` (`crates/yaran-core/src/engine/mod.rs:610`); decision `apply_attention_decision` (1290-1325, called 2007); queries 2116, 2173; view model `crates/yaran-core/src/viewmodel.rs:644, 828, 1303-1305, 1345`; push trigger `poll_attention_transitions` (`src/engine_actor.rs:3503-3516`, called 2656) -> WorkspaceDoc rebuild (3287). This transition point is the natural hook for a server-side push sender.
- Render: sidebar cyan pulse (`components/Sidebar.tsx:78-109`), phone list (`FlatAgentList.tsx:276-351`), status word "Needs you" + hot sort (`lib/flatList.ts:79, 183`), tab pill `AttentionDot` (`AgentTabsStrip.tsx:189-191`), vitals (`agentVitals.ts:33`), `document.title` "(N)" (`store.ts:1474-1488`, `lib/attention.ts:10-35`), favicon dot (`lib/favicon.ts:170-233`). Theater on phone: no signal by design (`lib/theater.ts:213`).
- `lib/notify.ts` raises nothing for attention (tenet: "nothing raises one for attention").
- Existing Notification API: `new Notification(title,{body,tag})` in `src/lib/agentNotifications.ts:131-149`, triggered only by the agent's own OSC 9/99/777 via xterm handlers (194-215), gated (`shouldFireNotification` 76-88) on `capabilities.web_notifications`, permission granted, page hidden/unfocused, 1 s debounce; registered per mounted terminal (`components/terminal/terminalSetup.ts:99-116`). Permission requested only from Preferences (`CustomizeWebappDialog.tsx:299-343`). Not driven by `needs_attention`; only fires for mounted panes with live PTY sockets.
- Absent: `PushManager`, `showNotification`, `setAppBadge`, `Audio`, SW push handlers. `navigator.vibrate(10)` only for long-press selection (`components/terminal/selectionDrag.ts:120`).
- WebView note: `window.Notification` does not exist in Android WebView or WKWebView (UNVERIFIED per version), so the existing OSC path is dead in a native shell; native push must come from the server via APNs/FCM, keyed on the attention transition above.

### `lib/notify.ts` (214 lines)
- `notify(tone,msg,{id?,sticky?})` 117; `notifyInfo/Success/Warning/Error` 129-144; `notifyBusy(msg,{id,origin})` 172; `notifyStatus` 197; `dismissNotification` 211. Base window 6 s (36), warn 3x, error 4x (40, 44); sticky = Infinity (122); busy guard 60 s replaces spinner with non-sticky warning (51, 170-193).
- Boundary test `src/lib/notifyBoundary.test.ts`: allow-list `["components/ui/sonner.tsx","lib/notify.ts"]` (51), assertions 121/125/129. Related `notifySticky.dom.test.tsx:68-103`.

## 7. Mobile shell and browser APIs that differ in a WebView

| API | file:line (web/) | Native-shell note (platform knowledge, UNVERIFIED on device) |
|---|---|---|
| viewport meta | `index.html:15` | `interactive-widget=resizes-content` Chromium-only; actual keyboard resize depends on Android `windowSoftInputMode` / iOS `contentInsetAdjustmentBehavior` (Capacitor Keyboard config) |
| visualViewport keyboard heuristic | `hooks/use-visual-viewport.ts:10-23`, `lib/viewport.ts:7-13` (100 px), `App.tsx:246-273` | with `adjustResize`, innerHeight shrinks too, so `keyboardLikelyOpen` may never trip |
| safe-area `env()` | `App.tsx:270-273`, `StandaloneEditor.tsx:49-52`, `ui/sonner.tsx:31-32`, `ui/popupSheet.ts:36`, `MacroPopover.tsx:151` | Android WebView reports 0 unless edge-to-edge is configured |
| SW + manifest | `lib/sw.ts`, `public/manifest.webmanifest` | manifest ignored; WKWebView SW only for App-Bound Domains |
| clipboard write | `lib/clipboard.ts:6-7` (+`execCommand` fallback 31); OSC 52 `agentNotifications.ts:158-163` | WKWebView wants a user gesture; usually fine |
| clipboard read | `lib/termClipboard.ts:73` (`readText`) | WKWebView shows Paste callout or refuses; Android needs host permission grant. Likely fails |
| paste event | `terminal/uploadPipeline.ts:359-393`, `lib/clipboardPaste.ts` | robust |
| file picker | `hooks/use-file-picker.tsx:25`, `lib/filePicker.ts` | Android WebView needs `WebChromeClient.onShowFileChooser` (Capacitor provides it); WKWebView native |
| drag and drop | `TerminalPane.tsx:977-994`, `FileTree.tsx:458-497`, `lib/editorDrop.ts:184-198` | effectively phone-dead already |
| visibilitychange | `reconnectingSocket.ts:461`, `heartbeat.ts:214`, `visibleClock.ts:69`, `useTerminalLifecycle.ts:397`, `hooks/use-revisit.ts:21`, `TaskManagerDialog.tsx:154` | fires on background if host calls `WebView.onPause/onResume` (Capacitor does, UNVERIFIED); iOS suspends JS so sockets die and are revived by wake signals |
| pagehide/freeze/resume | `lib/pageLifecycle.ts` | freeze/resume Chromium-only (and see §5 bug); pagehide may not fire on kill |
| beforeunload | `lib/editorDrafts.ts:93` | not honored in WebViews; dirty-draft guard lost |
| matchMedia | `hooks/use-mobile.ts:21` (<768 px), `use-coarse-pointer.ts:14`, `use-reduced-motion.ts:9` | fine |
| touch / long press | `terminal/touchGesture.ts:55` (400 ms), 159-168; `TerminalPane.tsx:333-335, 1005-1009`; `TheaterPill.tsx:722` | host must disable native long-press callout / text selection (`-webkit-touch-callout`, WebView settings) |
| vibrate | `terminal/selectionDrag.ts:120` | none on iOS; Android needs VIBRATE permission |
| Fullscreen API | absent | nothing to do |
| `window.open` / `target=_blank` | `terminal/linkPress.ts:88`, `MarkdownPreview.tsx:68`, `ChangedFiles.tsx:771` (standalone editor), anchors `MobileShell.tsx:369`, `PrBanner.tsx:28`, `AgentActionsMenu.tsx:224`, `FlatAgentList.tsx:415` | needs a native policy: external URLs (PR links, terminal links) -> system browser; standalone editor hash -> same WebView or a second in-app view |
| UA / platform sniffing | `lib/platform.ts:5-9`, `lib/paneDivider.ts:152`, `deviceLabel.ts:44`, `terminal/inputSurface.ts:384` | custom UA changes labels |
| Notification | `lib/agentNotifications.ts` | absent in WebViews |

## 8. App menu, Preferences, storage

- `src/lib/appMenu.ts` (278 lines): pure data, `AppMenuEntry = item{id,title,icon,run} | submenu | separator` (50-73), context `{ghAvailable, githubIntegrationEnabled}`; model 91-261: New ▸, Add project ▸, |, Preferences…, |, Sort agents by ▸, Configuration ▸, |, Task Manager…, |, Welcome screen…, What's new…. `findSubmenu` 265.
  - Renderers: desktop cog `components/AppMenu.tsx:23-96`; `AppMenuBody` (62) reused by the pane menus' Settings drill (`components/PaneMenu.tsx:66-120`); phone sheet `components/AppMenuSheet.tsx:124-164`, opened from hub cog `MobileShell.tsx:96-99`.
- Preferences: `components/CustomizeWebappDialog.tsx` renders `SETTING_GROUPS` from `src/lib/settingsDescriptors.ts` (descriptor 35-71: `key`, `surface` web/both/tui, `control`, `writeTarget` settings/identity/changesPane/github/tailscale, `inverted`, `lockedBy`, `read(bootstrap)`). Every descriptor is server config. The one per-device row is `NotificationPermissionRow` (296-343, rendered 688-691).
- Storage keys (reads via `brandedStorage.ts:5-25` with `dux` fallback): `yaran-chunk-reload` (session, `ChunkBoundary.tsx:14`), `yaran-editor-explorer` (`editorLayout.ts:23`), `yaran:theater-pill-position`, `yaran:theater-pill-hint` (`theaterPill.ts:14,17`), `yaran:theater:<pane>` (`theater.ts:13`), `yaran:typing-surface`, `yaran:direct-input-hint` (`typingSurface.ts:19,81`), `yaran:sidebar-width`, `yaran:changes-pane-percent` (`paneDivider.ts:167-168`), `yaran:show-diff-line-numbers` (removed at boot, `store.ts:853`). None machine-scoped: under one shared org origin all machines would share them (theater per pane id would collide across machines with the same pane ids).
- Where native-only entries go, per tenets:
  - "Switch machine…", "Sign out…": global actions/dialogs -> app menu (`appMenu.ts`), gated by a new `AppMenuContext` flag (e.g. `nativeShell`) so the browser build hides them; this automatically reaches desktop flyout, phone sheet and every Settings drill. Sign out = destructive-ish, trailing `…` + confirm.
  - "Notifications" on/off: a Preferences row, per-device like `NotificationPermissionRow` (not a config descriptor) unless it is meant to be server-side (per-device push registration lives on the server anyway).
  - Machine switcher state (list of paired machines) belongs to the native shell, not to yaran config (the web store has no notion of other machines).

## 9. Frontend test infra, lint, CI, strictness

- Vitest 4; config only `test.setupFiles: ["./src/testSetup.ts"]` (`vite.config.ts:11`, empty setup); default env node, jsdom per file via 135 `@vitest-environment` pragmas; matchMedia stub `src/test/matchMedia.ts`. 286 test files (187 `.test.ts`, 99 `.test.tsx`). No Playwright.
- Guard tests: dialog chip/quote guard `src/components/dialogNameChips.test.ts`; notify boundary `src/lib/notifyBoundary.test.ts`; viewport meta `src/lib/viewportMeta.test.ts`; cross-language fixtures `src/lib/prose.test.tsx:76-79` (`crates/yaran-core/tests/fixtures/prose_cross_language.json`), `releaseNotes.test.ts:135-138`, `FlatAgentList.test.tsx:1680-1682` (reads `working_cue.rs`); others `docs.test.ts:13`, `brandPath.test.ts:5`, `bidi.test.ts:48`, `blockArtFont.test.ts`.
- ESLint `eslint.config.js`: js + typescript-eslint recommended, react-hooks, react-refresh, custom no-unused-vars.
- TypeScript `tsconfig.app.json`: NOT `strict`, no `noUncheckedIndexedAccess`; has `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`; excludes tests (tests not type-checked by `tsc -b`).
- CI `.github/workflows/pr.yml`: `web-lint` (162-185) `npm ci && npm run lint`; `web-build` (192-215) `npm run build` then `npm run test`; Node 22, cwd `crates/yaran-web/web`.
- Preview container for visual checks: `tools/preview-env/` (per CLAUDE.md).

## 10. File sizes (non-test, >500 lines)

`lib/store.ts` 6335; `components/EditorBody.tsx` 2195; `TerminalPane.tsx` 1284; `FlatAgentList.tsx` 1270; `ChangedFiles.tsx` 1025; `TheaterPill.tsx` 860; `FileTree.tsx` 763; `CustomizeWebappDialog.tsx` 750; `ui/sidebar.tsx` 710; `TaskManagerDialog.tsx` 648; `MobileShell.tsx` 611; `lib/termkeys.ts` 599; `lib/fileDrop.ts` 594; `AddProjectDialog.tsx` 581; `terminal/resizeCoordinator.ts` 570; `Sidebar.tsx` 557; `lib/reconnectingSocket.ts` 551. Total src ~59.6k lines.
Touch points for this feature that are already large: `store.ts` (WS URL, boot, identity), `CustomizeWebappDialog.tsx` (any new Preferences row). New logic should go in new small modules.

---

## Implications for running the UI inside native apps and behind Access / Worker path-proxy

### Pick the shell model first (it decides most of the list)
- Model A, "remote WebView": the native shell's WebView navigates to `https://<machine-host>/` (Capacitor `server.url`, or a plain WebView). Page origin == API origin, so relative URLs, `credentials:"same-origin"`, Access's `CF_Authorization` cookie and the server's Origin==Host check all keep working with ZERO UI auth code. Needed: hostname in `allowed_hosts`; tunnel must preserve Host. Login is the Access redirect inside the WebView (Google IdP refuses embedded WebViews; One-time PIN / GitHub / service-token flows needed, UNVERIFIED).
- Model B, "bundled UI" (`capacitor://localhost` / `https://localhost`): breaks everything today. Needs a configurable API base URL in every fetch/WS site, CORS with credentials on the server, an Origin allowlist (the raw `Origin==Host` compare must grow an allowlist), a token strategy (WS cannot carry custom headers from a browser; Access cookies are third-party in this model), and a self-hosted copy of the UI that can drift from the server version (the server-run reload tenet assumes the page comes from the server). Much larger, and fights tenets. Recommend Model A.

### Concrete change list (Model A, with optional single-org-hostname path proxy)
1. Server Host/Origin:
   - Document that the tunnel hostname must go in `[server] allowed_hosts`; fix the misleading comment at `crates/yaran-tui/src/config.rs:1104`.
   - Make `same_origin_allowed` (`src/server.rs:914-956`) compare the normalised Origin authority to the normalised Host (ports, case) so `host:443` vs `host` does not 403. Add a test per case in the existing family.
   - If the tunnel rewrites Host (`httpHostHeader`), requests 403. Either require Host preservation (documented) or add an explicit "trusted origin" list. Do NOT trust `X-Forwarded-Host` without an explicit opt-in.
2. Path prefix (only if the Worker proxies `/m/<machine>/`):
   - Drop the leading `/` from all `/api/v1` literals (16 files listed in §3) and image/favicon refs (7); build WS URLs from `new URL("ws/...", location.href)` with `http->ws` swap (`store.ts:1069-1083`, `ptySocket.ts:46-111`); `register("sw.js")`; `sw.js` `OFFLINE_URL = "offline.html"`; manifest `start_url`/`scope` `"./"`, relative icons, add an `id`.
   - Proxy must redirect `/m/x` -> `/m/x/`.
   - Add a guard test (like `notifyBoundary.test.ts`) that fails on a root-absolute `"/api/`, `"/ws/`, or `src="/` literal in `src/`.
   - Per-machine hostnames avoid all of this; a shared org origin also shares `localStorage` keys (§8), the SW scope, and Access cookies across machines, and any Worker that rewrites Host collides with §2's Origin check. Prefer per-machine hostnames unless there is a strong reason.
3. Access-expired UX (both models):
   - Today an expired Access session looks exactly like "server down" (`OfflineOverlay.tsx:80-124`) and only a manual reload recovers. Add an auth-probe: when sockets fail, a `fetch("api/v1/build", {redirect:"manual"})` returning `opaqueredirect` (or a non-JSON / 401/403 response) means "sign-in needed"; show that in the overlay with a button that reloads (navigation reaches the Access login). Tenet-compatible (bounded, says out loud what happened).
   - Cap/strip HTML bodies in `jsonRequest.ts::responseError` (20-27) so a login page never becomes a toast.
   - Make `parseJsonResponse` on a 200 non-JSON response a failure, not `undefined` (29-38).
4. Manifest under Access: add `crossorigin="use-credentials"` to `<link rel="manifest">` (`index.html:6`), and update `viewportMeta`-style guard if one covers the head.
5. Native push for "needs you":
   - Server hook: `poll_attention_transitions` (`src/engine_actor.rs:3503-3516`) is the edge (false->true) to fan out APNs/FCM; needs a device-registration route (new attack surface: update `docs/operations/threat-model.md` and `SECURITY.md`) and must coexist with the tenet "nothing raises one for attention" in the web UI (push is a native-shell feature, not a toast).
   - The existing `agentNotifications.ts` Notification path is dead in WebViews; guard it on `"Notification" in window` (verify it already does) and do not try to reuse it.
   - Deep link from a notification -> hash route `#/agent/<id>` (router is hash-based and prefix-safe; `parseRoute` `store.ts:2312`).
6. WebView integration points (shell config, not UI code, unless noted):
   - `window.open` / `_blank` policy: external links to system browser; standalone editor (`ChangedFiles.tsx:771`) either same WebView or disabled in native builds.
   - Android file chooser (`onShowFileChooser`), clipboard-read permission, disable native long-press callout, keyboard resize mode vs the `visualViewport` heuristic (`lib/viewport.ts:7-13`), edge-to-edge for `env(safe-area-inset-*)`.
   - `beforeunload` draft guard is lost; acceptable (drafts are cached), but note it.
   - Device label: append a UA token (e.g. `YaranApp/<ver> (iPad)`) and teach `src/lib/deviceLabel.ts` to recognise it, fixing iPad -> "macOS".
7. Native-only menu entries: "Switch machine…" / "Sign out…" in `appMenu.ts` behind a new `AppMenuContext` capability flag supplied by a shell bridge (e.g. a `window.YaranNative` object or a UA token); "Notifications" as a per-device Preferences row next to `NotificationPermissionRow`.
8. QR pairing: the UI has no pairing surface; the payload (machine URL, Access team/app, optional service token) is minted by `yaran` CLI/TUI and consumed by the native shell, not by the web UI. `/.well-known` does not exist; if the shell needs machine metadata, `GET /api/v1/build` already exposes `{version, process}` and could carry a machine display name.
9. Low-risk fixes found along the way: `freeze`/`resume` listeners on `window` instead of `document` (`lib/pageLifecycle.ts:101-106`, UNVERIFIED); events socket has no app-level beat (half-open sockets after a radio handoff, common on phones); events-socket backoff/deadline use wall time contrary to the visible-time tenet.

### Not verified
Actual Cloudflare Access responses to fetch vs WS upgrade (302 vs 401/403), cloudflared default Host handling, Capacitor `onPause` wiring, WKWebView SW/Notification availability per iOS version, and whether tests assert exact `/api/v1` URLs (expect churn in ~47 files).
