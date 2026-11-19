# R1: yaran server / core / CLI internals, as they bear on a Cloudflare leg

Repo: `/Users/siavash/Projects/yaran` at `main` (ba9e61b9). All paths are relative to it. Four parallel Explore sub-agents did the tracing. The lead re-read these by hand: `host_guard.rs:202-237`, `server.rs:914-953`, `engine/mod.rs:1302-1325`, `main.rs:25-38`, `viewmodel.rs:1476`, `config_routes.rs:412-433`, the axum feature set and the rustport plan docs. Anything marked UNVERIFIED was not confirmed in code. Nothing was built or run.

---

## 1. Serving modes

There are three ways to serve. All of them run the same axum router (`build_app`, `crates/yaran-web/src/server.rs:776-846`).

### 1a. `yaran server`, with no TUI
- **Dispatch.** `main()` sends `"server"` to `run_server` (`crates/yaran/src/main.rs:28`, fn `:270-358`).
- **Argument parsing.** `parse_server_args` (`main.rs:388-455`) is a hand loop that accepts `--bind` (once only), `--port`, `--no-tailscale` and `-h`. It builds `ServerArgs` (`:370-376`), then `ServerCliOverrides` (`crates/yaran-core/src/config.rs:4072-4079`).
- **Startup.**
  1. Install the canonical renderer (`main.rs:292`), load config (`:293`), init the logger (`:298`).
  2. Compute `effective_tailscale_mode(mode, no_tailscale)` (`config.rs:814-823`).
  3. Detect the Tailscale IP, or print `undetected_warning` to stderr (`main.rs:305-326`).
- **Building the plan.** `resolve_server_plan(&server, &overrides, ts_ip)` (`config.rs:4109-4145`) works as follows:
  - `--bind` is parsed as a `SocketAddr` literal (`:4114-4120`). Without it, `parse_server_host(host)` takes IP literals only (`:4087-4096`), combined with `cli.port.unwrap_or(server.port)`.
  - Port 0 is refused (`:4126-4132`).
  - `plan_addrs(bind, ts)` (`:4151-4163`) makes the primary address `PlanAddr::required`. It adds the Tailscale IP on the same port as `PlanAddr::best_effort`, unless the primary is a wildcard or is already the Tailscale IP.
  - The result is `ServerPlan { addrs, primary, tailscale, forced_no }` (`:4050-4066`).
- **Non-loopback warning.** An address that is neither loopback nor Tailscale gets a loud stderr warning (`main.rs:340-348`).
- **Serving.** `yaran_web::run_server` (`crates/yaran-web/src/lib.rs:97`) calls `run_plain_http` (`lib.rs:397-596`):
  - `bind_plan_addrs` (`lib.rs:185-226`) binds with tokio `TcpListener`. A failed required address is fatal. A failed best-effort address only warns (`tailscale_bind_warning`, `:150-156`).
  - It prints the banner, `safety_note` (`:357-380`) and `waiting_note` (`serve_legs.rs:814-832`).
  - `spawn_engine_thread` (`lib.rs:481`, `engine_actor.rs:1826`) calls `run_engine_loop`.
  - It builds `TailscaleModeControl` (`lib.rs:489-494`), then `ServeShutdown::new(mode_control.watched())` (`:495`), then the router (`:508-525`).
  - It installs its own signal handler (`:529-535`) and calls `spawn_leg` once per listener (`:546-562`).
  - Then `TailscaleLoop::new(...).start_watcher_if_wanted` (`:565-574`), then `run_serve_loop` (`:576-586`).

### 1b. The `start-web-server` flip
This is a palette-only command; there is no CLI verb for it.
- **Entry.** `App::start_web_server` (`crates/yaran-tui/src/app/sessions.rs:4418-4511`).
- **Refusals.** It refuses while a background serve is in pre-flight (`:4428-4436`), and while a background serve is running (`:4437-4450`), naming `stop-background-server`. The reverse case is refused at `background_server.rs:239-246`.
- **Pre-flight on a worker.** It reads only `server.port` and the Tailscale mode, never `host`. Then `preflight_server_listeners(port, ts)` (`app/mod.rs:7951-7993`) binds std listeners for `config::local_addrs(port, ts)` (`config.rs:4169-4174`), which is `plan_addrs(127.0.0.1:port, ts)`. Loopback is required; Tailscale is best-effort.
- **Exit path.** `WorkerEvent::ServerFlipPreflightReady`, then `pending_server_flip`, then `RunExit::FlipToServer` (`app/mod.rs:4606`), then `TuiExit::FlipToServer` (`yaran-tui/src/lib.rs:221-234`). From there `run_tui_with_flip` (`main.rs:149-264`) calls `yaran_web::serve_with_engine` (`lib.rs:1786-1934`), which runs `ServeCore::start(…, SignalPolicy::Adopt, BackgroundHooks::default())`. The calling thread becomes `run_engine_loop`.
- **Status screen.** The URLs on the status screen are a snapshot (`yaran-tui/src/server_screen.rs:89,133`).

### 1c. `[server] serve_while_tui`, the background mode
- **The seam.** The `BackgroundServeCompanion` trait (`crates/yaran-core/src/background_serve.rs:214-317`, with `set_tailscale_mode` at `:295` and `connections` at `:264`). Its implementation is `WebCompanion` (`crates/yaran/src/companion.rs:20-182`).
- **Starting.** At startup through `start_background_server_from_config` (`yaran-tui/src/app/background_server.rs:193-197`), and from the palette or a reload through `start_background_server` (`:209-303`).
- **Pre-flight.** `spawn_background_server_preflight` (`:312-349`) does the same thing as the flip's pre-flight. Then `apply_background_server_preflight` (`:354-424`) calls `companion.start`, which runs `BackgroundServer::start` (`crates/yaran-web/src/background.rs:70-138`). That calls `ServeCore::start(…, Console::noop(), SignalPolicy::Inherited, BackgroundHooks{…})`.
- **Engine servicing.** The TUI owns the engine and lends it through `EngineService::service_engine_once` (`engine_actor.rs:2603`). `run_engine_loop` never runs in this mode.
- **Live URLs.** Read from `ServeCore::live_urls` (`lib.rs:1690-1698`).
- **Stopping.** `stop_background_server` (`:428-464`) and `stop_background_server_quietly` (`:469-497`).
- **Local mode is structural.** `ServeCore::start` (`lib.rs:1478-1676`) treats the loopback listener as the primary, any non-loopback listener as the Tailscale leg, and sets `forced_no=false` (`:1505-1512`, `:1575`). The two in-app modes never read `host`.

### 1d. `ServerConfig`
`crates/yaran-core/src/config.rs:874-1101` (`#[serde(default)]`), with defaults at `:2238-2270`.

| Field | Default | Notes |
|---|---|---|
| `host` | `127.0.0.1` | IP literal only |
| `port` | 3890 | |
| `tailscale` | `"auto"` | string, custom deserializer `:839-866` that also accepts the legacy bool |
| `allowed_hosts` | `[]` | |
| `color`, `access_log`, `serve_while_tui` | | |
| `max_websocket_{events,agent,terminal,tab}_connections` | 32 / 32 / 64 / 64 | |
| `max_websocket_tabs_per_agent` | 8 | |
| `title`, `favicon`, `shutdown_timeout_seconds` | | |
| `search_index_max_files` | | |
| `tree_list_max_concurrency`, `release_notes_max_concurrency` | | |
| `file_drop_max_bytes` / `_concurrency` | | |
| replay / reconnect / heartbeat timings | | |
| `pty_send_timeout_seconds` | | |

- **Helper.** `ServerConfig::tailscale_mode()` (`:1108-1110`).
- **Canonical commented renderer.** `config_schema()` (`crates/yaran-tui/src/config.rs:341`). The `[server]` section runs `:1022-1172`, with the tailscale entry at `:1067-1099`. It is registered by `install_canonical_renderer` (`:1938-1940`).
- **Migration.** `tailscale_enabled` → `tailscale` (`config_migrate.rs:150-153, 262-300`).

**Restart vs live.**
- Needs a restart: `server_bind_settings_changed` (`config.rs:1149-1167`), which covers host, port, **allowed_hosts**, the websocket caps, the file-drop limits and the concurrency caps. Restart warning copy: `engine_actor.rs:462-484`.
- Applies live (`config.rs:1128-1144`): tailscale (through the mode lane), access_log, search_index_max_files, pty_send_timeout, the browser timings, serve_while_tui (TUI only) and shutdown_timeout.
- Inconsistency (UNVERIFIED which side is right): the field doc for `search_index_max_files` says it needs a restart (`config.rs:996-997`).

---

## 2. The Tailscale leg: the template to copy

### 2a. Module map
| File | Lines | Contents |
|---|---|---|
| `crates/yaran-core/src/tailscale.rs` | 435 | `MODE_CHANGE_STATUS_KEY="tailscale-mode"`:25, `TailscaleUnavailable`:30, `undetected_warning`:62, `detect_ip`:99 (`DETECT_TIMEOUT` 5s :110), `detect_ip_with`:119, `parse_tailscale_ip`:163, `is_tailscale_cgnat`:188, `is_tailscale_ipv6`:202. 14 tests. Tests point at a fake CLI by absolute path, so PATH is never mutated (`:302-352`). |
| `crates/yaran-core/src/bounded_command.rs` | 220 | `run_command_with_timeout(cmd, timeout, drain, label) -> CommandOutcome{Completed,TimedOut,Failed}` :50-137 |
| `crates/yaran-core/src/config.rs` | 6520 | `TailscaleMode`:589-658, `TailscaleModeOutcome`:667-692, `.report()`→`TailscaleModeReport`:697-809, `effective_tailscale_mode`:814, `ServerConfig`:874, plan types :4003-4174 |
| `crates/yaran-core/src/background_serve.rs` | 447 | `BackgroundServeCompanion` trait (`set_tailscale_mode`:295) |
| `crates/yaran-core/src/wire.rs` | 13760 | `WireCommand::SetTailscaleMode`:255, dispatch :1865, `Engine::set_tailscale_mode`:2239-2251 (config write only) |
| `crates/yaran-core/src/worker.rs` | 882 | `TailscaleModeApplied`:721 |
| `crates/yaran-core/src/viewmodel.rs` | 3480 | bootstrap `tailscale_mode` / `tailscale_forced_no` :330,338,1469 |
| `crates/yaran-core/src/palette.rs` + `action.rs` | 789 + 835 | `set-tailscale-mode` :184-190; `Action::SetTailscaleMode` :199 |
| `crates/yaran-web/src/serve_legs.rs` | 1562 | `ServeShutdown`:60-229, `TAILSCALE_LEG_KEY`:236, `LegStatus`/`LegCoalescer`:245-423 (`LEG_SETTLE_DWELL` 6s), `best_effort_death_warning`:432, `LegCommand`:485, `LegStep`/`plan_leg_step`:498-521, `desired_leg`:531, `ModeStep`/`plan_mode_change`:545-602, `watch_tailscale_leg`:621-658, `ModeRequest`:693, `TailscaleModeControl`:708-789, `waiting_note`:814. 27 tests. |
| `crates/yaran-web/src/lib.rs` | 3532 | `spawn_leg`:642-693, `TailscaleLoop`:702-853, `run_serve_loop`:885-997, `apply_current_generation_command`:1008-1035, `apply_mode_request`:1071-1162, `finish_detection`:1171-1232, `reconcile_bound_tailscale`:1253, `apply_leg_command`:1277-1353, `router_params`:1379-1410, `ServeCore`:1445 / `start`:1478-1676, `serve_with_engine`:1786, `shutdown_signal`:1936-2018. 24 tests plus 15 `live_tailscale_mode_tests` (:2837). |
| `crates/yaran-web/src/background.rs` | 551 | `BackgroundServer`, `set_tailscale_mode`:174-185 |
| `crates/yaran-web/src/engine_actor.rs` | 7547 | `set_tailscale_mode_control`:771 (`OnceLock` slot), reload arm :2845-2914 |
| `crates/yaran-web/src/config_routes.rs` | 1499 | `POST /api/v1/server/tailscale-mode` :63 / :467-501 |
| `crates/yaran-web/src/host_guard.rs` | 535 | `TailscaleLiterals::{Fixed,Live}`:146-164 |
| `crates/yaran-web/src/console.rs` | 1252 | `bind_degraded`:412, `leg_changed`:420 |
| `crates/yaran/src/companion.rs` | 182 | `WebCompanion::set_tailscale_mode`:115 |
| `crates/yaran-tui/src/app/background_server.rs` | 2519 | picker :504-656, `save_and_apply_tailscale_mode`:564, `ask_companion_for_tailscale_mode`:590-622, `apply_tailscale_mode_outcome`:625-654 |
| Frontend | | `web/src/lib/settingsDescriptors.ts:366-389` (Preferences row), `configApi.ts:63-84` |

### 2b. The tri-state
- `TailscaleMode{Auto(default),Yes,No}` (`config.rs:589-606`).
- `parse` trims and is case-insensitive (`:611-618`).
- `wants_tailscale()` is true for Auto and Yes. `watches_interface()` is true for Auto only (`:644-658`).
- An unknown value warns once and is corrected to auto in memory (`:3842-3848`).

### 2c. Detection
- Detection only runs the CLI `tailscale ip` through `bounded_command`. It never probes an interface.
- Mapping (`tailscale.rs:119-157`): a spawn error becomes `CommandMissing`, a timeout or non-zero exit becomes `CommandFailed`, and unparseable output becomes `NoAddress`.
- `bounded_command` polls every 50 ms, kills and reaps on timeout, and kills **only the direct child**, with no process group (`bounded_command.rs:118-119`).

### 2d. Watcher thread and generations
- The watcher is a std thread named `yaran-tailscale-watch` (`lib.rs:826-838`). It runs `watch_tailscale_leg` (`serve_legs.rs:621-658`) with every collaborator injected:
  - `WATCH_PERIOD` is 5 s and doubles as the flap debounce. It parks in 250 ms slices.
  - It computes `desired_leg`, then `plan_leg_step` (Nothing / Bind / Unbind / Rebind), re-checks `stop()` after the probe, and calls `blocking_send((generation, LegCommand))`.
- **Generations.** `TailscaleLoop.generation` is bumped by `stop_watcher` and by every one-shot detection (`lib.rs:797-803, 1139`). Stale commands are dropped at `:1021`. The queue holds 8.
- **The bound cell.** `TailscaleLoop.bound` has the serve loop as its only writer.

### 2e. `TailscaleModeControl` (`serve_legs.rs:708-789`)
- **Fields.** `tx: mpsc::Sender<ModeRequest{mode, reply: oneshot}>` (depth 8), the runtime handle, a `watched: Arc<AtomicBool>` and a `host_literals: Arc<AtomicBool>`.
- **Methods.** `set_mode(mode).await` waits up to 7 s and maps a closed lane to `NotServing`. `set_mode_detached(mode, report_cb)` is for std-thread callers.
- **Holders.**
  1. The engine actor's `OnceLock` (`engine_actor.rs:771-776`).
  2. `AppState.tailscale_mode` / `tailscale_forced_no` (`server.rs:143-147, 567-575`).
  3. `ServeCore.tailscale_mode` (`lib.rs:1457, 1707`).
- **Callers.**
  - Web: the `POST /api/v1/server/tailscale-mode` route first writes config through `WireCommand::SetTailscaleMode`, then calls `control.set_mode`, and replies `{mode, warning, message, segments}`.
  - TUI palette: `set-tailscale-mode` writes config, then, if background-serving, `ask_companion_for_tailscale_mode` runs `WebCompanion` → `BackgroundServer::set_tailscale_mode` → `set_mode_detached`. The result comes back as `WorkerEvent::TailscaleModeApplied` → `apply_tailscale_mode_outcome`.
  - Both reload arms (section 2h).
- **Shared outcome text.** Every surface shares one sentence per outcome through `TailscaleModeOutcome::report(mode)`. The variants are Applied{bound}, Detached, NothingDetected, NoPrimary, BindFailed, RefusedForcedNo, NotServing, Superseded and TimedOut.

### 2f. Serve loop arms (`run_serve_loop`, `lib.rs:885-997`, `tokio::select!`)
1. `parent.changed()`: shutdown.
2. `mode_requests.recv()` → `apply_mode_request`. The arm disables itself when the lane closes.
3. Pending one-shot detection → `finish_detection`.
4. `tasks.join_next()` → `finish_leg_task`. A panic is fatal; otherwise it reconciles.
5. Status dwell timer → `LegStatus::flush_due`.
6. `commands.recv()` → `apply_current_generation_command` → `apply_leg_command`, which either binds and calls `spawn_leg(required=false)` or calls `shutdown.stop_leg`.

After the loop ends, any pending detection is answered `NotServing`, `ts.shutdown()` runs and the remaining tasks are drained.

**The pure planner.** `plan_mode_change(prev, next, bound, forced_no) -> Vec<ModeStep>`, where `ModeStep` is `StopWatcher | Unbind | DetectAndBind | StartWatcher{probe_now} | SetHostLiterals(bool) | Refuse`:
- `forced_no` with a wanting mode → Refuse.
- No → Unbind, then literals off.
- Yes → literals on, then DetectAndBind.
- Auto → literals on, then StartWatcher{probe_now:true}.

Literals go on before a bind and off after an unbind (`serve_legs.rs:566-602`). The detection runs in `spawn_blocking` as its own select arm and is never awaited inside the mode arm (`lib.rs:1135-1150`).

### 2g. Best-effort vs required failure
- `ServeShutdown` keeps a parent watch plus a per-leg `HashMap<SocketAddr, watch::Sender>`:
  - `record_failure`: the first failure trips everything.
  - `record_best_effort_failure`: logs it and forgets the leg (`serve_legs.rs:60-229`).
- `spawn_leg` routes a leg's error to one or the other (`lib.rs:642-693`).
- `LegStatus` posts keyed statuses on `"tailscale-leg"` through `EngineHandle::post_status`, which reaches both surfaces, with a 6 s coalescing dwell.
- `ServeCore::is_failed` stops the flip. In background mode, `retire_if_failed` retires the companion (`companion.rs:35-53`).

### 2h. `--no-tailscale` and reload ownership
- **`--no-tailscale`** is a `yaran server` flag only. It:
  - forces No,
  - sets `ServerPlan.forced_no`,
  - skips startup detection,
  - starts the guard's live literals cell from the effective mode (`lib.rs:518-523`),
  - makes a live change answer `RefusedForcedNo` (`:1105-1107`),
  - and is projected to the bootstrap as `tailscale_forced_no` (`bootstrap_routes.rs:35`).
- **Reload: `yaran server` and the flip.** The `run_engine_loop` reload arm (`engine_actor.rs:2845-2914`) captures prev/next modes before the swap (`:2857`). When the mode changed, it calls `control.set_mode_detached` and posts a `WireStatus::keyed(MODE_CHANGE_STATUS_KEY, …)` (`:2884-2906`).
- **Reload: background mode.** The TUI's `apply_reloaded_config` (`yaran-tui/src/app/mod.rs:6020-6120`) captures `tailscale_before` (`:6055`), then `apply_serve_while_tui_setting` (`:6093`), then calls `ask_companion_for_tailscale_mode` only when a serve was running both before and after and the mode changed (`:6101-6107`). The actor's arm never runs here (`engine_actor.rs:2886-2889`), so the change is never applied twice.

### 2i. Flow
```
config [server] tailscale ─► TailscaleMode ─(+--no-tailscale)─► effective mode
    │                                                          │
startup detect_ip (bounded 5s)                          plan_addrs / local_addrs
    │                                                          │
    └──────────► TailscaleModeControl::new ◄───────────────────┘
       ┌──────────────┬──────────────┼───────────────┬─────────────────┐
  actor OnceLock   AppState      ServeCore      watched cell      host_literals cell
  (reload arm)   (POST route)  (bg companion)  (ServeShutdown)   (HostAllowlist rule 5)
       └────── set_mode / set_mode_detached ──► mpsc<ModeRequest>
                                                   │
   run_serve_loop select!: shutdown | mode req→plan_mode_change | detect | join_next | dwell | (gen,LegCommand)
                     │                                   ▲
            spawn_leg / stop_leg               "yaran-tailscale-watch" thread
            (required vs best-effort)          (park 5s → detect → desired_leg → plan_leg_step)
                     │
            Console + LegStatus → EngineHandle.post_status → TUI status line + browser toasts
```

---

## 3. Host guard and same-origin check

### 3a. `HostAllowlist::allows_host` (`crates/yaran-web/src/host_guard.rs:202-237`, verified)
**Normalisation** (`normalize_host_for_match`, `:78-91`): trim, strip the port (unbracketed IPv6 counts as malformed), lowercase, and drop one trailing dot. Then the rules apply in order:

1. `localhost`, or any loopback IP.
2. Any bound IP is unspecified (0.0.0.0 or ::) → accept any IP literal.
3. The exact IP was bound. This is a snapshot taken when the router was built (`lib.rs:500, 1495-1499`) and is not updated when a later leg binds.
4. The host appears in `configured` (`[server] allowed_hosts`): an exact match after normalisation, with no wildcard and no subdomains (tests at `:416-441`).
5. A Tailscale-range literal (`100.64/10`, `fd7a:115c:a1e0::/48`), while `tailscale_literals.allowed()` is true. That flag is `TailscaleLiterals::{Fixed(bool), Live(Arc<AtomicBool>)}` (`:146-164`), read with SeqCst on every request.

MagicDNS names need an `allowed_hosts` entry (`:29-34`).

**Middleware** (`:246-264`): a Host that is present but not allowed gets **403 `this yaran server does not serve the requested host`**. A missing or invalid Host gets 403 `missing or invalid Host header`.

**Installation** (`server.rs:836-846`): the guard is the outermost layer, after `.with_state`. It covers `/healthz`, static assets, all of `/api/v1/*` and every WebSocket upgrade. Rejected requests never reach the access log.

Layer order, outermost first: host guard → `access_log` (`server.rs:830`) → `rest_mutation_origin_check` (`:821`) → handlers.

**Configuration** (`config.rs:898-903`): the knob is `[server] allowed_hosts: Vec<String>`.
- There is no CLI flag for it.
- Changing it needs a **restart** (it is in the bind set).
- The web raw-config editor refuses to change `host` or `allowed_hosts` (`engine_actor.rs:4024-4036`).
- The field doc says the entries apply when the request is "NOT same-origin". That is misleading: the guard runs on every request.

### 3b. Same-origin (`server.rs:914-953`, verified)
- `same_origin_allowed`: no `Origin` header → allow. Otherwise `origin_host(origin) == raw Host header`, where `origin_host` keeps the text after `://` and cuts at `/?#`. `"null"` and values with no scheme give `None`, which is a mismatch.
- The **scheme is deliberately ignored**. The comparison is an **exact, case-sensitive raw string compare**: unlike the guard, it does not lowercase or strip ports.
- `rest_mutation_origin_check` (`:970-980`) applies to POST, PATCH, PUT and DELETE only, and answers 403 `cross-origin request rejected`.
- WebSocket upgrades are GET requests, so each upgrade handler checks itself and answers 403 `cross-origin WebSocket upgrade rejected`:
  - events: `:2587-2593`
  - session pty: `:1281`
  - session terminal: `:1338`
  - project terminal: `:1395`
  - standalone terminal: `:1453`
  - tab: `:1562`
- **Proxy headers.** There is no handling of `X-Forwarded-*`, `Forwarded` or `CF-*` anywhere in yaran-web, yaran-core or yaran (grep is empty). The peer IP comes only from `ConnectInfo` (`lib.rs:665`). It appears in console and log lines, but nothing gates on it, and the caps are global rather than per IP.

### 3c. A request through cloudflared (Host `alice.example.com`, Origin `https://alice.example.com`)
That cloudflared preserves the Host header by default is outside this repo and UNVERIFIED.

| Setup | Result |
|---|---|
| `allowed_hosts=[]` (the default) | **Every request gets 403** from the guard, `/healthz` included. |
| `allowed_hosts=["alice.example.com"]` | The guard passes (rule 4). `origin_host` gives `alice.example.com`, which equals Host, so mutations and WebSockets pass too. **Everything works.** |
| cloudflared rewrites Host (`httpHostHeader: localhost:3890`) | The guard passes (rule 1), but `alice.example.com ≠ localhost:3890`, so every mutation and WebSocket gets 403. GETs still work. A half-broken UI: **do not rewrite Host.** |
| Forwarded Host carries `:443` or different casing from Origin | The guard passes, but the origin check fails. |

- **HTTP/2.** The server speaks **HTTP/1.1 only**: the workspace dependency is axum 0.8 with only `ws` added (`Cargo.toml:50`), and axum's defaults do not include `http2`. cloudflared's HTTP/2-to-origin option must stay off (UNVERIFIED how cloudflared behaves if it is on).
- **wss.** The frontend builds `wss:` from `location.protocol` and `location.host` (`web/src/lib/store.ts:1068-1074`, `web/src/lib/ptySocket.ts:43-47`), so pages served over HTTPS work.

---

## 4. Server identity, routes, sockets, caps, ownership

### 4a. Identity and unauthenticated endpoints
- **`GET /api/v1/build`** (`build_routes.rs:60-73`) returns `{"version", "process"}` with `no-store`.
  - `PROCESS_ID` is a `LazyLock` UUIDv4 minted once per process (`:46-47`).
  - The route never touches the engine.
  - It drives the client's hard-reload-on-new-run.
  - A stop/start of the background serve keeps the same id (`lib.rs:1443-1444`).
- **`GET /healthz`** returns the plain text `ok` (`server.rs:813`). The access log skips it.
- **Every endpoint is unauthenticated** (`server.rs:6-7, 222-223, 774-775`). In particular:
  - `/api/v1/browse` lists any directory the process can read.
  - `GET/PUT /api/v1/config/raw` reads and writes the whole `config.toml`. `GET` returns the raw text (verified, `config_routes.rs:412-420`).
  - `/api/v1/bootstrap` includes **`global_env: self.config.env.clone()`** (verified, `viewmodel.rs:1476`).

### 4b. Route table (built at `server.rs:776-831` and merged from these modules)
- **server.rs:** `/healthz`; the fallback `web_assets::static_handler`; the 6 WebSocket routes in 4c.
- **git_routes.rs** (`/api/v1/sessions/{id}/git/`, all POST): stage, unstage, stage-files, unstage-files, discard, commit, push, pull, refresh-changes.
- **file_routes.rs**, under three prefixes (`/api/v1/sessions/{id}/files`, `/api/v1/terminals/{tid}/files`, `/api/v1/projects/{pid}/terminals/{tid}/files`):
  - list, tree, read, `GET raw`, write, info, create-file, create-dir, rename, delete, open-in-editor;
  - plus `diff` on the session prefix only.
- **Small route modules:**
  - `changes_routes.rs`: `GET /api/v1/sessions/{id}/changes`
  - `resource_routes.rs`: `GET /api/v1/resources`
  - `bootstrap_routes.rs`: `GET /api/v1/bootstrap`
  - `build_routes.rs`: `GET /api/v1/build`
- **workspace_routes.rs** (all GET): workspace, projects, sessions, `sessions/{id}`.
- **session_actions.rs:**
  - `POST sessions`, `pull-requests/resolve`, `sessions/reorder`, `sessions/reorder-global`
  - `PATCH` / `DELETE sessions/{id}`; `GET branch-unpushed`
  - `POST reconnect`, `rerun-startup-command`, `kill`, `recreate-working-copy`
  - `PUT` / `DELETE pull-request`; `POST pull-request/autodetect`
- **project_actions.rs:** `POST projects`, `projects/reorder`; `PATCH` / `DELETE projects/{id}`; `POST pull`, `checkout-default`.
- **project_reads.rs:** `GET inspect`, `worktree-counts`, `{id}/worktrees`; `DELETE {id}/worktrees`.
- **startup_logs.rs:** 4 GET routes.
- **terminal_actions.rs:**
  - session terminals: `POST`, `DELETE`
  - project terminals: `POST`, `DELETE`
  - `POST terminals/reorder`; standalone terminals: `POST`, `DELETE`
- **file_drop_routes.rs:** `POST /api/v1/file-drop?pty=`.
- **tab_actions.rs:** `POST tabs`, `DELETE` / `PATCH tabs/{tab}`, `POST tabs/{tab}/start`, `PUT focused-tab`.
- **browse_routes.rs:** `GET browse`, `POST browse/mkdir`, `GET agent-name`.
- **config_routes.rs** (`:31-72`):
  - `PUT` macros, global-env, `ui/changes-pane`
  - `POST config/reload`, plus several `ui/toggle-*` / `defaults/*` / `github/recheck` routes and `config/instance-identity`
  - `PATCH config/settings`
  - **`POST server/tailscale-mode`**
  - `GET` / `PUT config/raw`
- **first_load_routes.rs:** `POST first-load/dismiss`; `GET release-notes`, which makes an outbound GitHub fetch.

Handler line numbers for every route are in the sub-agent trace. The module and route membership above was checked against the router merges.

### 4c. WebSockets
- **`/ws/events`:**
  - First frame: `{"event":"connected","id":"<uuid>"}` (`server.rs:2656, 2678-2689`).
  - Client to server: `{"subscribe":[…],"unsubscribe":[…]}`. Limits: 64 topics per frame and per connection, 256 characters per topic.
  - Server to client:
    - resource events `{event,id?,rev?,owner?,epoch?,device?}`: `session.changes`, `projects.changed`, `sessions.changed`, `config.changed`, `pty.owner`;
    - `{"event":"workspace","rev":N,"workspace":{…}}`, the full spine;
    - `status` / `status_cleared` toasts;
    - a ping every 30 s.
- **PTY sockets.** There are five routes: `/ws/sessions/{id}/pty`, `…/terminals/{tid}/pty`, `/ws/projects/{id}/terminals/{tid}/pty`, `/ws/terminals/{tid}/pty` and `/ws/sessions/{id}/tabs/{tab}/pty`.
  - Handshake: `{"event":"connected","id":"<u64 conn_id>","gen","owner","owner_epoch","owner_device"?,"rows","cols","grid_seq"}`, then one Binary frame with the replay (`:2394-2458, 1871-1881`).
  - Server to client: Binary bytes, `size`, `beat`, and close code 4001.
  - Client to server: Binary stdin (gated by ownership), resize `{rows,cols,takeover?,expected_owner?}`, and beat `{beat?,viewed?}`.
  - Before upgrading, each handler checks Origin, then the id bound, then existence (404 otherwise), then takes a cap permit.

### 4d. Caps and limits
- **Per-class semaphores** (`server.rs:714-727`): events 32, agent 32, terminal 64, tab 64, plus 8 tab sockets per agent (`TabWsGuard`). Over the cap, the request gets an **immediate 503** `too many WebSocket connections; try again shortly` (`:1084-1099`).
  - A cap of 0 disables that class.
  - There is no total HTTP connection cap.
- **Body limits.** axum's 2 MB default, with these overrides:
  - config/raw: 256 KiB
  - stage-files: 1 MiB
  - file write: about 10 MiB
  - file-drop: `file_drop_max_bytes`, 100 MiB by default
  - WebSocket message: 16 MiB
  - captured User-Agent: 200 characters

### 4e. Device label (`crates/yaran-core/src/device_label.rs`, 278 lines)
`short_device_label(raw)` (`:109-128`):
1. Strip control characters. An exact `TUI_DEVICE_LABEL` passes through.
2. Detect the OS: Android, then iOS, then Windows, then macOS, then Linux.
3. Detect the browser: Edge, then Firefox, then Chrome/CriOS, then Safari.
4. Return `"{browser} on {os}"`, or just the OS, or the text cut to 24 characters with "…".

It mirrors `web/src/lib/deviceLabel.ts`. The server stores and broadcasts the **raw** UA, bounded in length. A native app's UA (for example okhttp or CFNetwork) would currently come out as truncated raw text.

**Connection ids:**
- events id: UUID
- PTY registry id: UUID, never disclosed
- PTY ownership `conn_id`: process-global `AtomicU64` (`pty_owners.rs:84-89, 119-121`)
- replay `gen`: `AtomicU64`

### 4f. PTY ownership registry (`crates/yaran-core/src/pty_owners.rs`, 1492 lines)
- **Types:** `PtySizeOwners`, `OwnerRecord{conn_id, device}`, `WriteClaim`, `ResizeClaim`, and grid-order helpers.
- **`claim_for_resize(pty, conn, takeover, expected_owner, device, apply)`** (`:166-225`):
  - The caller already owns it → apply.
  - Someone else owns it and this is not a takeover → refuse.
  - A takeover whose `expected_owner` does not match → refuse.
  - Otherwise → record the new owner, bump epoch and generation, and apply under the lock.
- **Writes:**
  - `may_write` (`:271-311`): the first writer claims an unowned pty.
  - `write_if_owner` (`:326-336`).
- **Release:**
  - `release(pty, conn)` only clears the owner if that connection still holds it.
  - `release_all` is used by the TUI.
- **Web side:** one registry per serve, shared with the engine actor. `PtyOwnershipGuard` releases on drop and emits `pty.owner`.

### 4g. Static assets and security headers
- Assets are embedded with rust-embed, Brotli-compressed, and served with ETags. Anything outside `assets/` falls back to the SPA (`web_assets.rs:189-208`).
- **There is no CSP, HSTS, X-Frame-Options or CORS layer.** The only CSP is the sandbox on the file `raw` route (`file_routes.rs:650-663`).

---

## 5. Attention ("needs you") and where a push hook goes

### 5a. Signals (`crates/yaran-core/src/attention.rs`)
- **Scanner.** `AttentionScanner::scan_full` (`:165-194`) emits three events:
  - `Bell`: a bare 0x07.
  - `Notify`: OSC 9 / 777;notify / 99 (kitty), final displayable parts only (`classify_osc` `:392-433`).
  - `Progress{working}`: OSC 9;4, which never counts as attention.
- **No message text.** `AttentionEvent::Notify` is a unit variant (`:67`). The body survives only as raw bytes in the passthrough capture ring (`CapturedSeq`, `:96-99`).
- **Scope.** `PtyClient::scan_signals` (`pty.rs:1086-1120`) scans agent tabs only, never companion terminals. It sets the atomics.
- **Drain.** `take_attention(count_bell)` (`pty.rs:2080-2084`) swaps the flags off.

### 5b. State and rollup
- `Engine.needs_attention: HashSet<TabId>` is per tab and memory-only (`engine/mod.rs:604-610`).
- **Single drain site:** `Engine::poll_agent_signals` (`:1978-2008`).
  - `enabled = ui.attention_indicator`, `count_bell = ui.attention_on_bell`.
  - The `fired` tabs are collected only when `enabled` is true.
  - Then `apply_attention_decision` (`:1302-1325`, verified) runs:
    - Disabled → `clear()`.
    - Otherwise `retain(!engaged)`, then `insert` each fired tab that is not engaged.
- **"Engaged"** (`attention_engaged`, `:1275-1289`) means viewed within 3 s (`ATTENTION_ENGAGED_WINDOW`) or recent input.
- **Agent rollup** is an OR over tabs: `session_needs_attention` (`:2160-2178`) and `viewmodel.rs:1301-1305`.
- **Clearing:**
  - `note_agent_viewed[_if_known]` (`:2097-2112`). The TUI calls it from `note_focused_agent_viewed` (`yaran-tui/src/app/input.rs:3862-3878`, with grace). The web calls it from `handle_subscribe` (`engine_actor.rs:4091-4098`) and from the PTY beat frame's `viewed:true` (`server.rs:2121-2124` → `EngineRequest::NoteViewed`). The browser only sends `viewed:true` when it is the owner and visible.
  - `clear_tab_runtime` (`engine/events.rs:1535-1540`).

### 5c. On the wire
- `SessionView.needs_attention` (`viewmodel.rs:640-644`) and `AgentTabView.needs_attention` (`:826-828`) travel inside the full `{"event":"workspace",…}` spine push.
- There is no dedicated attention delta frame.
- `EngineService::poll_attention_transitions` (`engine_actor.rs:3507-3516`) only diffs the set as a level, to open the push gate. It exists only in the web service, so it is the wrong hook.

### 5d. Existing notifications
- **TUI:** captured OSC 9/99/777 sequences are replayed raw to the host terminal (`Engine::take_host_passthrough`, `engine/mod.rs:2023-2066`). Nothing drains that ring under `yaran server`.
- **Browser:** `web/src/lib/agentNotifications.ts` uses xterm OSC handlers and `new Notification`. This only works for a mounted pane in an open tab.
- **Server side:** there is no notification code at all.

### 5e. Hook point (recommended)
- **Where.** `apply_attention_decision`'s `needs_attention.insert(tab)` returning `true` (`engine/mod.rs:1323`), or a diff right after the call at `:2007`. That is an exact rising edge per tab, already de-duplicated and filtered for engagement.
  - Falling edges, if you want to withdraw a push: the `retain`, `note_agent_viewed`, `clear_tab_runtime` and `clear()`.
  - Owner lookup: `owning_session_for_tab` (`:5589`).
- **It runs in every mode,** browser or not:
  - `yaran server` and the flip: `run_engine_loop` → `run_maintenance` → `poll_agent_signals` (`engine_actor.rs:2453, 2917`).
  - Plain TUI and TUI with background serve: `prepare_run_tick` (`yaran-tui/src/app/mod.rs:4621-4628`).
- **Constraints:**
  - `Engine` is `!Send` (`background_serve.rs:3-7`), so the hook must hand off over a channel to a worker. It must never block the tick; in background mode the tick is also the server's request loop.
  - It inherits the `ui.attention_indicator` switch: `fired` is empty when that is off.
  - With no viewer, every bell or notify becomes an edge.
  - The push body has no text. The session/tab name can come from the engine. The OSC body would need a non-draining read of the passthrough ring, because the TUI drains it.

---

## 6. CLI structure
- **No parsing crate:** no clap anywhere. Everything is hand-matched strings.
- **`main.rs:27-38` (verified):** `server`, `--version|-V`, `peer`, `board`; **anything else → `run_tui_with_flip()`**. `yaran_tui::run` (`crates/yaran-tui/src/lib.rs:77-162`) then handles `doctor`, `config` and `session`, and **launches the TUI for any other argument**. So today `yaran login` silently opens the TUI.
- **`config` subcommands** (`yaran-tui/src/cli.rs:19-52`, 3029 lines): `reset [--all]`, `diff [--raw]`, `regenerate [--yes]`, `restore-docs`, `path`.
- **Help.** The help text is at `yaran-tui/src/lib.rs:256-301`, and tests assert each subcommand is listed (`:320-384`).
- **Where a new command goes.** Add a `Some("login") | Some("cloud")` arm next to `peer` and `board` in `main.rs`. Those are the precedent for commands that take no lock and run no engine, with the logic in a yaran-core module (as `human_board/cli.rs` does with `run_board` / `run_with`, 1343 lines). Also add a help line.
- **Opening a browser.** `yaran_core::browser::open_url` (`browser.rs:5`, 263 lines) runs `open` on macOS and `xdg-open` elsewhere, with a detached spawn, null stdio, a 500 ms watch and a reaper thread. Test builds refuse it through `test_provider::refuse_unlisted_launch`. Its only production caller is the TUI (`app/mod.rs:109`).

---

## 7. Child processes, probes, downloads
- **Long-lived helpers.** **There is no long-lived helper-process supervisor.** Non-PTY children either finish or run detached:
  - startup commands use `.output()` with no timeout (`startup.rs:223-319`);
  - the editor is spawned detached (`editor.rs:181-187`);
  - `amq` uses `.output()`.
- **Process groups.** Group kill appears only in `file_drop.rs:2386-2523` (probably test code, UNVERIFIED).
- **Reusable pieces:**
  - `bounded_command` for probes such as `cloudflared --version`;
  - the injected-collaborator watcher shape and `park` slices (`serve_legs.rs:621-675`);
  - `WatchBackoff{initial_ms,max_ms,multiplier,jitter_ms}` (`watch/rule.rs:170-186`, jitter in `watch/engine.rs:500-505`);
  - the PTY teardown pattern: SIGTERM → grace → KILL → reap (`pty.rs:2314-2366, 2610-2681`; `engine/lifecycle.rs:1992-2030`).
- **Signals:**
  - The server's `shutdown_signal` (`lib.rs:1936-2018`) handles SIGINT/SIGTERM; a second signal forces exit 130.
  - The TUI uses `signal_hook` for SIGWINCH/TERM/INT/HUP (`yaran-tui/src/app/mod.rs:1146-1160`).
  - Quit runs `engine.shutdown_ptys(grace)` (`lib.rs:1876-1898`).
- **Reload exec.** A reload exec keeps children: `pty_adopt_child.rs` rebuilds a `Child` from a pid after exec. A cloudflared child would need the same treatment, or a kill-and-respawn across reload (UNVERIFIED design question).
- **Download and verify:**
  - `install.sh` (401 lines) uses curl/wget against GitHub releases. `verify_checksum` (`:187-240`) is fatal on a mismatch but only warns when the checksum is missing.
  - `yaran-amq/install.sh` pins `AMQ_SHA256` and fails closed (`:34-46, 95-104`); that is the pinned-hash precedent.
  - `release.yml` (506 lines) produces per-archive `.sha256` files, a combined checksums file, and build provenance attestation. It is unsigned.
  - **There is no self-updater and no in-binary download code.**
- **HTTP client.** `ureq 3.3.0` on rustls 0.23 with ring and webpki-roots is already a yaran-core dependency. Its only use is `release_notes.rs:507-523`: 5 s timeouts, worker thread only. reqwest and hyper are dev-only. There is no direct hash or signature crate; `sha2` is only transitive.
- **Workspace dependencies:** tokio (yaran-web only), axum 0.8 `ws`, tracing, serde, uuid, rustix, libc, url, rand 0.8 (core), signal-hook (tui).

---

## 8. Secrets and credential storage
- **`file_modes.rs`** (351 lines):
  - `PRIVATE_FILE_MODE 0o600`, `PRIVATE_DIR_MODE 0o700`.
  - `restrict_to_owner` only clears bits, skips symlinks, and treats a missing path as Ok.
  - `restrict_to_owner_best_effort` warns instead of failing.
  - `create_private_dir_all`.
  - Policy: the 0700 config root is the boundary (`:1-18`).
  - `YaranPaths::ensure_dirs` sets the root to 0700 on every start (`config.rs:2612-2645`).
- **Atomic private writers to reuse:**
  - `config_write::write_config_atomic`: 0600 temp file, fsync, rename, fsync of the directory (`config_write.rs:46-100`).
  - **`human_board::store::write_private` / `write_atomic`**: `create_new` with mode 0600, sync, rename, cleanup, `flock` (`human_board/store.rs:150-164, 336-374`). This is the best template for a token file.
- **Encryption at rest.** `docs/operations/encryption-at-rest.md` (347 lines) is only an operator guide (gocryptfs/LUKS) with an opt-in helper. **No application-level encryption, keyring or keychain code exists.** Threat T5 says so explicitly (`threat-model.md:241-245`).
- **GitHub tokens.** yaran stores none; it delegates to `gh auth status` (`gh.rs:1227-1256`).
- **Never put the tunnel token in `config.toml` or `[env]`:**
  - `[env]` is sent to every browser in the bootstrap (`viewmodel.rs:1476`, verified).
  - It is exported into every agent's environment (`agent_env.rs:7-9, 33`).
  - The whole `config.toml` is readable over `GET /api/v1/config/raw` (verified).
  - Behind a tunnel, all of these become reachable to anyone who gets past Access.
- **`config diff` redaction.** `config diff` summarises `env` and reports only counts for `projects`/`macros` (`yaran-tui/src/cli.rs:510-527`). `--raw` prints everything.

---

## 9. Status controller, serving crumb, palette

### 9a. `statusline.rs`
- **Types:**
  - `StatusScope{All, Connection}`
  - `QuietSurfaces{web,tui}`, which can only withhold an Info (`:45-87`)
  - `LiveStatusKeys` with register / retire / is_live (`:124-165`)
  - `StatusTone{Info,Busy,Warning,Error}`
  - `StatusRetention{Retain, Emit}`
  - `KeyedStatusController`, whose methods include `set`, `clear`, `tick`, `take_late_finals`, `snapshot`
- **Constants:** `BUSY_TIMEOUT` 20 s, `BUSY_LIVE_CEILING` 30 min, `FINAL_REPLAY_WINDOW` 30 s.
- **Producers:**
  - `StatusUpdate` with `info` / `warning` / `error` / `keyed(key,tone,msg)` / `.sticky()` / `.with_scope()` / `.quiet_on()` (`engine/events.rs:69-206`).
  - The typestate `status_op(pending).on_success(..).on_failure(..)`, run by `Engine::spawn_status_op` (`spawn_worker.rs:181-221`), which registers the live key; or `.resolve_in_handler(..)` (`status_op.rs:203-300`).
  - `begin_status_op`.
- **`status_text!` / `StatusText`** (`status_text.rs:120-158`): `q(x)` is a chipped name and `n(x)` a bare name. The TUI prints only the plain message.
- **Route to both surfaces.** `Engine::post_status` → `WorkerEvent::PollerStatus` (`engine/mod.rs:3145-3155`) → `EventReaction::Status`:
  - TUI: `notify_companion` + `apply_routed_reaction` (`workers.rs:349-365`).
  - Server: `fanout_reaction` (`engine_actor.rs:2265-2273`).
- **Key constants.** `wire::status_keys` (`wire.rs:16-30`); `tailscale::MODE_CHANGE_STATUS_KEY`; `serve_legs::TAILSCALE_LEG_KEY`.
- **Worked example.** `background_server.rs:590-654` (pending → `resolve_in_handler` → `Final::warning` / `Final::info`, with a fallback to `post_status(StatusUpdate::keyed(MODE_CHANGE_STATUS_KEY, …))`).

### 9b. Serving crumb and remote counts
- **The crumb.** `App::serving_chip()` (`background_server.rs:30-39`) builds `"● serving :PORT · N connected"` with `serving_chip_label` (`:785-795`), rendered at `render.rs:1707`.
  - Data path: `BackgroundServeCompanion::connections` → an `AtomicUsize` gauge (`background.rs:142-144`) installed by `BackgroundHooks.connections_gauge` into `ConnectionRegistry::with_events_gauge` (`rest_common.rs:141-153`).
  - It counts `/ws/events` connections only, and only in background mode.
- **Per-agent "N remote".** `remote_viewer_count` (`yaran-tui/src/app/mod.rs:7321-7342`) sums PTY broadcast subscribers. It is rendered at `render.rs:837-842, 2134`.
- **Activity panel.** The flip's activity panel counts through `ActivityRing.connections` (`activity.rs:94-111`).

### 9c. Palette
- **Declaring a command:**
  - a `PaletteCommand{action,name,description}` in `PALETTE_COMMANDS` (`palette.rs:27+`);
  - an `Action` variant plus arms in `config_name` / `config_description` / `help_section` (`action.rs`);
  - a `BindingDef` (`yaran-tui/src/keybindings.rs`), pinned by `palette_listing_matches_core_registry`.
- **Dispatch.** `App::execute_command(name)` matches on the string (`app/mod.rs:5649-5695`). Availability is gated by `is_palette_action_available` (`:5495+`).
- **Existing server commands** (`palette.rs:162-191`): `start-web-server`, `start-background-server`, `stop-background-server`, `set-tailscale-mode`.
- **Web side.** The web has no palette. Its home for actions is `web/src/lib/appMenu.ts`, and settings go in `settingsDescriptors.ts`; the Tailscale row is `server.tailscale`.

### 9d. Engine files (`wc -l`)
| File | Lines |
|---|---|
| `engine/mod.rs` | 12579 |
| `events.rs` | 10309 |
| `lifecycle.rs` | 7558 |
| `command.rs` | 3131 |
| `amq.rs` | 2161 |
| `watch_tick.rs` | 1574 |
| `companion.rs` | 1280 |
| `resume_fallback.rs` | 1202 |
| `provider_sessions.rs` | 1140 |
| `status_op.rs` | 600 |
| `spawn_worker.rs` | 519 |

The remaining files are under 600 lines.

---

## 10. Logging and sanitize
- **`logger.rs`** (1834 lines):
  - `init` opens a rotating `yaran.log` with JSON Lines `{timestamp, level, target, fields}`.
  - The free functions `info` / `warn` / `error` / `debug` write under `yaran::legacy` and sanitize their input (`:120-134, 209-220`).
  - `tracing::*!` events go through the same writer, and their string fields are sanitized (`:246-330`).
  - Logs are owner-only (`:790-813`).
  - The convention for new code is `tracing::warn!(target: "yaran::<module>", …)`, but most existing code still calls `logger::*` with `[module]` prefixes (for example `tailscale.rs:135`).
- **`sanitize.rs`** (169 lines):
  - `for_terminal` escapes C0, C1, DEL and 0x9b, keeping `\n` and `\t` (`:21-37`).
  - Also `utf8_lossy`, `truncate`, `amq_handle`, `prose_segments`.
  - It must never log.
- **No secret redaction exists.** cloudflared's stderr, which can echo token-bearing URLs, must be filtered by the caller (UNVERIFIED what cloudflared prints).

---

## 11. Modularity reality check
- **Over the limit.** **127 of 285 tracked `.rs` files are over 500 lines.**

  Largest files:
  | File | Lines |
  |---|---|
  | `yaran-tui/src/app/input.rs` | 39165 |
  | `render.rs` | 27841 |
  | `wire.rs` | 13760 |
  | `engine/mod.rs` | 12579 |
  | `git.rs` | 11542 |
  | `app/mod.rs` | 10472 |
  | `events.rs` | 10309 |
  | `sessions.rs` | 9354 |
  | `pty.rs` | 8935 |
  | `lifecycle.rs` | 7558 |
  | `engine_actor.rs` | 7547 |
  | `server.rs` | 6604 |
  | `config.rs` (core) | 6520 |
  | `storage.rs` | 6239 |
  | `yaran-tui/src/config.rs` | 5824 |

  Files a Cloudflare leg would touch that are already over 500 lines: `serve_legs.rs` 1562, `yaran-web/src/lib.rs` 3532, `server.rs` 6604, `engine_actor.rs` 7547, `config_routes.rs` 1499, `host_guard.rs` 535, `config.rs` 6520, `wire.rs` 13760, `viewmodel.rs` 3480, `background_server.rs` 2519, `app/mod.rs` 10472, `yaran-tui/src/config.rs` 5824.

  Under 500 lines: `tailscale.rs` 435, `background_serve.rs` 447, `companion.rs` 182, `main.rs` 564 (just over), `bounded_command.rs` 220, `file_modes.rs` 351.
- **Gate tooling.** `docs/plans/rustport/02-ci-gates-and-modularity-enforcement.md` specifies `ci/check-file-length.sh` (500 lines, with a `// allow-long-file:` opt-out), a cargo-modules module-tree `--check` and orphan detection. **None of it exists:**
  - there is no `ci/` directory;
  - no workflow references a length or module-tree check;
  - `allow-long-file` appears 0 times in `crates/`.
  
  The rustport README marks the plan set as a "Historical record, pre-workspace paths".
- **Header convention.** `docs/plans/rustport/CONVENTIONS.md` (§1 is the `//!` header with `# Uses` / `# Used by` trees; §2 is the 500-line rule, tests included) is **not adopted**: 0 files carry `//! # Uses`.
- **What this means for new work.** A new Cloudflare module set can follow the 500-line and header rules voluntarily. Nothing enforces them. The seams it must edit live in files that are 1.5k to 14k lines long.

---

## Implications for a Cloudflare leg

### What is structurally different from Tailscale
A Tailscale leg is an extra **listener**: a bind on a 100.x address. A Cloudflare leg adds **no listener**. cloudflared dials out and forwards to the existing loopback primary. So these pieces have no counterpart: `ServeShutdown`'s per-address leg registry, `desired_leg`/`plan_leg_step`, the rule-3 bound-IP snapshot, and the interface watcher with its generations. They exist for an interface that comes and goes. cloudflared reconnects to the edge on its own, so the leg's job is to **supervise one child process**, not to watch an interface.

### Seams to touch, and what to reuse
1. **Config** (`crates/yaran-core/src/config.rs` + `yaran-tui/src/config.rs` schema `:1022-1172`):
   - a new `[server] cloudflare`-style key, or a `[cloudflare]` section, with a tri-state enum modelled on `TailscaleMode` (parse / as_str / unknown_value_warning / deserialize correction), a commented canonical entry, live-vs-restart classification in `server_bind_settings_changed` / `:1128-1144`, and an `upgrade_config` test;
   - **portable intent only**: the org URL and the mode. **The token goes elsewhere** (see item 6).
2. **Core leg module, new, beside `tailscale.rs`:** a probe for `cloudflared --version` using `bounded_command`, an `Unavailable` enum, `undetected_warning`-style copy, a `MODE_CHANGE_STATUS_KEY`-style key, and an outcome enum with a `.report(mode)` that returns one sentence for both surfaces.
3. **Supervisor (new code, nothing to copy):**
   - spawn cloudflared with `process_group(0)`, piped and sanitized stderr going to `tracing` target `yaran::cloudflare`, and restart with `WatchBackoff` jitter;
   - SIGTERM → grace → KILL → reap on shutdown, mirroring the PTY teardown, wired into each mode's wind-down (`lib.rs:1876-1898`, `BackgroundServer` stop, flip `finish`);
   - decide what happens across a reload exec (the `pty_adopt_child.rs` precedent, or kill and respawn).
   
   A child death is **best-effort** (warn via a `LegStatus`-style keyed status, never trip `ServeShutdown`), unless the mode is the `yes` equivalent and policy says otherwise.
4. **Control lane:** copy the `TailscaleModeControl` shape (`mpsc<Request{mode, reply}>`, `set_mode` / `set_mode_detached`, every request answered, a bounded timeout). Add one `select!` arm in `run_serve_loop` (`lib.rs:885-997`), or a sibling loop, and a pure `plan_*_change` planner with unit tests. Distribute it through the same three holders: the actor `OnceLock` (`engine_actor.rs:771`), `AppState` via `RouterParams` (`server.rs:567-584`), and `ServeCore` for background mode.
5. **Host guard** (`host_guard.rs`):
   - Today the tunnel hostname must be in `allowed_hosts`, which needs a restart and is refused by the raw-config editor. Add a **live hostname rule**, the analogue of `TailscaleLiterals::Live` (for example an `Arc<RwLock<Option<String>>>` or an `ArcSwap` of the provisioned hostname), written only by the serve loop after the tunnel comes up and cleared after it goes down.
   - Keep cloudflared forwarding the **original Host**, never `httpHostHeader`, so the raw-string `same_origin_allowed` (`server.rs:914-926`) passes.
   - Force HTTP/1.1 to the origin (axum has no `http2` feature).
   - No `X-Forwarded-*` support is needed for correctness. Peer IPs will all read as loopback.
6. **Token storage:** a separate owner-only file under the 0700 config root, written with the `human_board::store::write_private` / `write_atomic` pattern plus `file_modes`. It must **never** go into `config.toml` (served by `GET /api/v1/config/raw`) or `[env]` (sent in the bootstrap and exported to agents). Pass it to cloudflared through an environment variable or a file, not argv (argv is visible in `ps`).
7. **CLI:** add `Some("login")` / `Some("cloud")` arms in `crates/yaran/src/main.rs:27-38` beside `peer` / `board`: no lock, no engine, logic in a yaran-core module. Update the help text at `yaran-tui/src/lib.rs:256-301` and its tests. Use `browser::open_url` for SSO, a tokio or std loopback listener for the redirect, and `ureq` (already present, rustls) for Worker calls on a worker thread.
8. **Surfaces:**
   - TUI: a palette command with its `Action` arms and `BindingDef`, a picker modelled on `open_set_tailscale_mode_prompt`, the companion trait method `BackgroundServeCompanion::set_cloudflare_mode`, and `WebCompanion` plus a `WorkerEvent::…Applied`.
   - Web: a Preferences row in `settingsDescriptors.ts`, a `POST /api/v1/server/<x>-mode` route modelled on `config_routes.rs:467-501`, and a bootstrap projection.
   - Optionally the public URL in the serving crumb, the banner and `safety_note` (`lib.rs:357-380`), which today know nothing about a public tunnel.
9. **Reload ownership:** apply mode changes in **both** owners, exactly as Tailscale does: the `run_engine_loop` reload arm (`engine_actor.rs:2845-2914`) for `yaran server` and the flip, and the TUI `apply_reloaded_config` (`app/mod.rs:6020-6120`) for background mode. Each must capture before/after prior to the swap.
10. **Push hook:** add an edge emitter at `apply_attention_decision` (`engine/mod.rs:1302-1325`): the `insert()` return value gives the rising edge, and `retain`/`clear` give falling edges. It sends `(session_id, tab_id, label)` over a channel stored on `Engine` to a worker that POSTs to the Worker. It must not block (the tick is the request loop in background mode). It inherits `ui.attention_indicator` unless it is decoupled, and it has no OSC body text without a non-draining peek of the passthrough ring.
11. **Device label:** extend `device_label.rs` and `web/src/lib/deviceLabel.ts` so native-app UAs (or an app-set UA) produce a readable label on the take-over card.
12. **Docs and threat model:** append a new threat after T24 in `docs/operations/threat-model.md` and the STRIDE table in `SECURITY.md`. Neither mentions Tailscale or tunnels today, and the intro text has drifted ("T1–T20"). Cover the new network exposure and egress, the stored token, the external binary, and the fact that Access is the **only** authentication in front of an unauthenticated API with filesystem read/write, config rewrite and PTY input. Update the README, the `website/docs/` pages and the config docs.
13. **Binary acquisition:** there is no in-binary downloader. Either require a user-installed `cloudflared` (probe it, then signpost) or add a pinned-hash download modelled on `yaran-amq/install.sh` (fail closed). Adding a hash crate would be new; `sha2` is only transitive today.

### UNVERIFIED (external or unchecked)
- cloudflared's default Host-header passthrough, its HTTP/2-to-origin behaviour, and what its stderr prints.
- Whether the `file_drop.rs` process-group code is test-only.
- Frontend render internals.
- Whether `doctor --anonymize` prints `[env]`.
