# Phase 12 — yaran: attention event emitter to the control plane

**Track:** B (yaran core) · **Parallel-safe with:** 04, 05, 06, 07, 08, 10, 11, 13–18
**Depends on:** 02 (`EventBatch`/`Event`/`EventBatchResult` and `MachineConfig` schemas, signing canonical string, error codes), 09 (`[cloud]` config section, credentials store, signed HTTP client), 01 (header gate) · **Blocks:** 19

## Goal

When an agent tab starts needing its owner, stops needing them, or its run ends badly,
yaran tells the org control plane in a signed `POST /v1/machine/events`, so the Worker
(Phase 08) can push to the owner's phones. This must work in all three serving modes,
must never block the engine tick, must survive an offline laptop for a bounded time, and
must not send agent content: only ids, the agent's label, its project and a state token.

## Evidence

All lines re-verified against `main` at `ba9e61b9` on 2026-11-14.

- **Signals carry no text.** `AttentionEvent::Notify` is a unit variant
  (`crates/yaran-core/src/attention.rs:58-72`). The OSC body survives only in the host
  passthrough ring (`:96`), which the TUI drains. So the payload is built from engine
  data, never from the terminal.
- **The attention set.** `Engine.needs_attention: HashSet<TabId>`, memory-only
  (`engine/mod.rs:604-610`).
- **The decision.** `apply_attention_decision` (`engine/mod.rs:1302-1325`): disabled →
  `clear()` (`:1308-1310`); otherwise `retain(!engaged)` (`:1313`) then `insert` each
  fired tab the user is not engaged with (`:1315-1324`). It is a free function, so it can
  be called on any set.
- **The single drain site.** `poll_agent_signals` (`engine/mod.rs:1978-2008`) reads
  `enabled = ui.attention_indicator` (`:1980`) and `count_bell = ui.attention_on_bell`
  (`:1981`), always drains `take_attention` but records a hit only
  `&& enabled` (`:1993-1994`), and calls the decision at `:2007`.
  The `engaged` predicate is `attention_engaged` (`:1275-1289`: viewed within
  `ATTENTION_ENGAGED_WINDOW`, or typed within `AGENT_INPUT_SUPPRESSION_WINDOW`).
- **Falling edges outside the tick.** `note_agent_viewed` removes at `engine/mod.rs:2099`
  (callers: TUI `app/input.rs:3876`; web `engine_actor.rs:3736` and `:4098`).
  `clear_tab_runtime` removes at `engine/events.rs:1538`, reached from the exit prune
  (`lifecycle.rs:920`), kill, detach, reconnect, close-tab, resume fallback and session
  delete. Config reload never touches the set (`engine/mod.rs:2466`, `:2501-2518`).
- **Bad-exit verdict.** `Engine.failed_tab_runs: HashMap<TabId, TabRunVerdict>`
  (`engine/mod.rs:633`), set only by `mark_tab_run_failed` (`:2137-2147`), which is
  called from `process_agent_launch_failed` (`engine/events.rs:2415`) and the exit prune
  (`lifecycle.rs:994`, after `clear_tab_runtime` at `:920`; the bad-ending test is at
  `:966`, `RAPID_EXIT_WINDOW = 5s` at `:101`). `TabRunEnding::wire_kind()`
  (`tab_verdict.rs:54-61`) is the one stable spelling of an ending.
- **Ticks in all three modes.** `yaran server` and the flip: `run_engine_loop`
  (`yaran-web/src/engine_actor.rs:2806`) → `run_maintenance` (`:2442`) →
  `poll_agent_signals` (`:2453`), every `TICK = 50ms` (`:376`). Plain TUI and TUI with
  `serve_while_tui`: `prepare_run_tick` (`yaran-tui/src/app/mod.rs:4621`) →
  `poll_agent_signals` (`:4628`); the background companion does not run
  `run_maintenance` (`engine_actor.rs:2436-2441`). So `poll_agent_signals` is the one hook
  that runs in every mode. `poll_attention_transitions` (`engine_actor.rs:3507-3516`) is a
  web-only level diff and is the wrong hook.
- **`Engine` is `!Send`** (`yaran-web/src/background_serve.rs:3`): work must leave the
  tick as owned data over a channel.
- **Owned-thread precedent.** `ConfigWriteQueue` (`config_queue.rs:35`, spawn at
  `:114-121`, status lane `Option<Sender<WorkerEvent>>`, `Drop` with explicit `Shutdown`
  and bounded join at `:286-330`) is held as an `Engine` field (`engine/mod.rs:272`) and
  survives the flip because the engine is moved, not dropped. Its constructors are called
  at `yaran-web/src/bootstrap.rs:108`, `yaran-tui/src/app/mod.rs:4174` and
  `engine/test_support.rs:38`. The `Engine` struct literal sites are
  `yaran-web/src/bootstrap.rs:195`, `yaran-tui/src/app/mod.rs:4250` and
  `engine/test_support.rs:121`.
- **Statuses from a worker.** `WorkerEvent::PollerStatus(StatusUpdate)` (`worker.rs:446`)
  reaches both surfaces; `StatusUpdate::keyed` (`engine/events.rs:161`). Key constants
  live in `wire::status_keys` (`wire.rs:16`).
- **Payload data.** `owning_session_for_tab` (`engine/mod.rs:5589`), `session_by_id`
  (`:5430`), `AgentSession::display_label()` (`model.rs:802`, the one display rule),
  `project_name_for_session` (`engine/mod.rs:4885`; returns `"unknown"` for a
  project-less agent, so it is not used for standalone agents), `folder_path()`
  (`model.rs:758`). Core has no state WORD: `row_state::RowState` (`row_state.rs:18-25`)
  is the decision and each surface words it (`row_state.rs:1-8`).
- **Helpers.** `sanitize::truncate(s, max_chars)` (`sanitize.rs:45`) sanitizes then
  truncates by chars. `watch::rule::WatchBackoff` (`watch/rule.rs:170-199`) is the
  existing jittered exponential backoff. `ureq 3.3.0` is a direct dependency
  (`crates/yaran-core/Cargo.toml:49`). A std `TcpListener` mock server is the test
  precedent (`crates/yaran-core/tests/release_notes_fetch.rs:49`).
- **Existing attention tests** sit in the `engine/mod.rs` test module:
  `apply_attention_decision_*` (`:7833-7875`), `poll_agent_signals_*` (`:7922-7964`),
  helper `seed_signaling_provider` (`:7889`).

## In scope

Edge detection in core, the event builder, the emitter thread with coalescing, a bounded
offline queue with a TTL, signed delivery through Phase 09's client, revocation handling,
the two `[cloud]` keys this phase adds, keyed statuses for failures worth surfacing,
structured logging, tests.

## Out of scope

- The `[cloud]` section, `mode`, `push_notifications`, credentials file, machine key and
  signed HTTP client: **09**. This phase consumes them and adds two keys through 09's
  config checklist.
- What happens on the cloud leg when the machine is revoked (stopping cloudflared,
  surfaces): **10**. This phase reports the verdict to 10's seam.
- The Worker's events endpoint, fan-out, Web Push and the relay: **08**. Event schema and
  error codes: **02**. Phone-side rendering and notification removal: **16**.
- Docs and threat-model rows: **17** (this phase hands it the facts listed under Work
  item 7).

## Design

### The push-only attention set (D12)

D12 (amended 2026-11-14 to this phase's design) makes the hook "the rising edge of the
attention decision, computed on a push-only set". Why a second set: the original wording
("the rising edge of `needs_attention.insert()`", "decoupled from
`ui.attention_indicator`") was self-contradictory in the code, because when the indicator
is off `fired` is empty (`engine/mod.rs:1993-1994`) and the set is cleared every tick
(`:1308-1310`), so `needs_attention` never has an edge. This phase therefore runs the
**same pure decision** (`apply_attention_decision`) on a second, push-only set, fed by the
**same** `fired` list and the **same** `engaged` predicate, at the **same** call site, with
`enabled = push_enabled`. When the indicator is on, the two sets are computed from
identical inputs and differ by at most one 50 ms tick (a `note_agent_viewed` removal lands
in the UI set at once and in the push set on the next tick through `engaged`). No other
decision is affected.

### Data flow

```text
engine tick (poll_agent_signals, every mode)
  ├─ fired: drained for every tab, regardless of the indicator     (1-line change)
  ├─ apply_attention_decision(needs_attention, fired, indicator)   (unchanged)
  └─ self.observe_push_tick(&fired, now)                           (1 call, engine/push_hook.rs)
        ├─ PushEdges::observe(fired, push_enabled, engaged, live) -> Vec<Edge>   (pure)
        └─ per edge: build protocol Event from engine data -> PushEmitter::offer() (try_send)
mark_tab_run_failed (engine/mod.rs:2137)
  └─ self.observe_push_bad_exit(tab, &ending)                      (1 call)
                     │ bounded mpsc (never blocks; full ⇒ counted drop)
                     ▼
"cloud-push" thread (cloud/push_emitter.rs)
  ├─ PushQueue: per-tab net-change coalescing, TTL, capacity     (pure, time injected)
  ├─ load credentials (09) at flush time; none ⇒ discard quietly
  ├─ signed GET /v1/machine/config (W5) at start, on retune, while paused ⇒ cached limits
  ├─ signed POST /v1/machine/events via 09's client (EventBatch ≤ events.max_batch ≤ 16)
  └─ results ⇒ backoff / drop / pause / revoked ⇒ 10's seam + keyed status
```

### Edge detection (`PushEdges`)

- State: `shadow: HashSet<TabId>` (the push-only attention set) and nothing else.
- `observe(fired, enabled, engaged, live)`: snapshot `before = shadow.clone()`, call
  `apply_attention_decision(&mut shadow, fired, enabled, engaged)`, then
  `shadow.retain(live)` where `live` is "the tab still has a provider in
  `self.providers`" (the map `poll_agent_signals` already iterates at `engine/mod.rs:1987`, and which `clear_tab_runtime` empties first, `engine/events.rs:1526`). That
  `retain` is what turns a `clear_tab_runtime` (exit, kill, detach, close, delete) into a
  falling edge without touching any of its nine callers. Edges are `shadow − before` →
  `Raised`, `before − shadow` → `Cleared`.
- Diffing once per tick (rather than hooking `insert`) is deliberate: an `insert` of an
  already-flagged tab is a no-op, and removals happen in three places outside the
  decision.
- When push is disabled, `enabled = false` clears the shadow; the resulting `Cleared`
  edges are swallowed by the emitter being off (see Gate), so turning push off sends
  nothing and withdraws nothing already delivered. The inline config comment says so.

`apply_attention_decision` and `attention_engaged` are private to `engine/mod.rs`. Per
00-CONVENTIONS §1.2 they are **moved first** (own PR) into a new
`crates/yaran-core/src/engine/attention_decision.rs` with `pub(crate)` visibility; `mod.rs`
keeps a `use`, and the five `apply_attention_decision_*` tests move with them unchanged.

### Bad exits

`observe_push_bad_exit(tab, ending)` emits one 02 `ExitEvent` (`kind:
agent_exited_badly`) carrying `ending.wire_kind()` and, for `ExitedWithStatus`, the
status as `exit_status`. It is skipped when the user
is engaged with the tab (same `attention_engaged` predicate): someone looking at the tab,
or who just pressed start on it, already sees the dormant crash surface. It does not
consult `ui.attention_indicator`. A tab that ends badly while flagged also produces a
`Cleared` edge on the next tick (its provider is gone); the coalescer keeps both because
they are different kinds, and Phase 16 shows the exit notification in place of the
attention one (same collapse key, 02's `topic(m, a, t)`).

### Event content (no agent content)

Built in `engine/push_hook.rs` from engine data only, into Phase 02's Rust type
`yaran_core::cloud::protocol::Event` (the `AttentionEvent` | `ExitEvent` union; never a
local re-declaration):

| Field | Source |
|---|---|
| `id` | a fresh UUID v4 per event, minted at the edge; the Worker's 24 h idempotency key, so it is kept unchanged across retries |
| `kind` | `attention_raised` / `attention_cleared` / `agent_exited_badly` |
| `ts` | 02 `Timestamp` (RFC 3339 UTC, seconds) at the edge; the Worker turns it into the push payload's Unix-seconds `ts` |
| `agent_id` | `owning_session_for_tab(tab)` |
| `tab_id` | the tab, **omitted** when it is the agent's first tab, decided only by the session's pointer (`AgentSession::slot_tab_id()`, `model.rs:841`), never by position |
| `state` (attention kinds only) | a RowState token, never prose: `attention_raised` carries `needs_attention`; `attention_cleared` carries the agent's state after the clear, `row_state::agent_row_state(status, working, typing, false)` (`row_state.rs:29`, the same inputs the TUI passes at `yaran-tui/src/app/render.rs:400`) mapped by an exhaustive match to `typing`/`busy`/`idle`/`detached`/`exited`, and `idle` when the session no longer resolves. `ExitEvent` carries no `state` |
| `ending`, `exit_status` | `wire_kind()` / `status()`, exit events only (`exit_status` only when known) |
| `label` | `display_label()`, through `sanitize::truncate` to 02's `maxLength` (64) |
| `project` | project name when `project_id()` resolves; for a standalone agent the folder's final path component; chosen by an exhaustive match on the workspace (never the `"unknown"` fallback) |

The machine id is added by the thread from the credentials file; the engine never reads it.
The phone words the token (Phase 16), because core deliberately has no word function and a
third copy of the ladder's words would drift. When the cached `MachineConfig.push.detail`
is `minimal` the thread drops `label` and `project` before sending (02; the Worker strips
them again, Phase 08).

### Gate

The emitter is **on** iff `[cloud] push_notifications = true` **and** `[cloud] mode != no`
(both from 09). It is independent of `ui.attention_indicator` and shares only
`ui.attention_on_bell` (the drain gate, which is a property of the signal, not of the UI).
Pairing state is checked on the thread at flush time by reading 09's credentials file, so
a `yaran cloud login`/`logout` run in another process is picked up with no coordination
and the tick never touches the filesystem. Unpaired is a normal state: events are dropped
at `debug` level with no status. `retune_after_config_swap` (`engine/mod.rs:2501`), which
both reload owners already call, starts or stops the thread idempotently.

### Coalescing, queue, delivery

- **Net change per tab.** The queue keeps, per tab, the last state the Worker
  acknowledged and the newest pending state. A pending entry is flushed only after
  `push_coalesce_seconds` (default 2) have passed since its first edge, and only if it
  differs from the acknowledged state. A raise cleared inside the window (the user glanced
  at the TUI) sends nothing. Exit events are one-shot and never coalesced away.
- **Bound and TTL.** At most 256 pending events (compile-time safety bound, a named
  constant beside its reason, like `BUSY_LIVE_CEILING`); overflow drops the oldest and
  counts it. An event older than `push_offline_ttl_seconds` (default 600) is dropped:
  a stale "needs you" is worse than none.
- **Batching.** The body is always 02's `EventBatch` (`{"events":[…]}`, even for one
  event), at most `MachineConfig.events.max_batch` events (02 caps it at 16; 16 until the
  config is known), and consecutive requests are at least
  `MachineConfig.events.min_interval_ms` apart.
- **Machine config.** The thread fetches the signed `GET /v1/machine/config` (W5, 09's
  client) when it starts, on every `retune`, and every `CONFIG_RECHECK = 15 min` (a named
  constant) while paused, and caches `push.enabled`, `push.detail` and `events`. A
  `410 machine_revoked` here is the same revocation verdict as below.
- **Acknowledgement.** A 202 `EventBatchResult` acknowledges every id in `accepted` and in
  `duplicates` (a duplicate means an earlier attempt already landed). `push_enabled:
  false` (or a cached `push.enabled = false`) **pauses** the emitter: pending events are
  discarded, nothing is sent, and the config recheck above resumes it when the org turns
  push back on (02: "yaran may stop sending until config says otherwise"). Pausing is
  logged at `info` and raises no status (the org admin chose it; `yaran cloud status`
  shows it).
- **Retries.** Network errors and 5xx back off with `WatchBackoff { initial_ms: 2_000,
  max_ms: 120_000, multiplier: 2.0, jitter_ms: 1_000 }`; 429 `rate_limited` and 503 wait
  `Retry-After`. A retry re-sends the same event ids (the Worker dedupes on `id`) and
  re-signs every attempt per 02 §7 (fresh timestamp and nonce, so `nonce_replayed` cannot
  trip); a duplicate notification is harmless anyway because the device keys
  notifications by 02's `topic(m, a, t)`.
- **Terminal answers.** `400 validation_failed`/`bad_request`, `413 payload_too_large` and
  any other non-retryable 4xx not named here drop the batch and log at `warn` (a bug,
  never retried). `410 machine_revoked` and `401 machine_unknown` stop the emitter, hand
  the verdict to 10's revocation seam, and raise the keyed status below. `401
  signature_expired` raises a status naming the skew from `details.server_time`.
  `yaran cloud logout` (09, `POST /v1/machine/unpair`) deletes the credentials file, so
  the next flush finds none and discards quietly.
- **Shutdown.** `Drop` sends `Shutdown`; the thread converts every acknowledged `Raised`
  into `Cleared` with state `idle` (02's default when the emitter cannot tell; the agents
  die with the process), flushes once, and is joined with a
  2 s bound, mirroring `ConfigWriteQueue`. The flip moves the engine, so it does not stop.
- **Never blocks the tick.** `offer` is `SyncSender::try_send` on a 512-slot channel.

### Statuses (only failures worth surfacing)

One key, `wire::status_keys::CLOUD_PUSH`, warnings only, sent as
`WorkerEvent::PollerStatus` on the engine's status lane so both surfaces get it:

- Events expired unsent: "N phone notifications from this machine were dropped because
  `<org>` could not be reached for 10 minutes (`<sanitized error>`). yaran keeps trying;
  run `yaran cloud status` to check the connection."
- Revoked: "Phone notifications stopped: `<org>` says this machine is no longer paired.
  Run `yaran cloud login <org>` to pair it again."
- Clock skew: names the measured offset and says to fix the system clock.

Recovery after an expiry warning posts a keyed info on the same key so the warning does
not linger. Success is silent (the phone buzzing is the confirmation). Messages are built
with `status_text!` so names chip on the web.

### Logging

Target `yaran::cloud::push`. `debug` per edge (tab id, kind); `info` on each recovery and
each expiry batch with counts (`sent`, `coalesced`, `expired`, `overflow`); `warn` on
terminal answers. Labels and project names are never logged above `debug`, and every
Worker error body passes through `sanitize::for_terminal` before it is logged or shown.

## Work items

1. **Extract the attention decision (pre-PR, §1.2).**
   - Create `crates/yaran-core/src/engine/attention_decision.rs` (~120 lines): moves
     `attention_engaged` and `apply_attention_decision` verbatim, `pub(crate)`. Header
     tree: Uses `ids::{TabId, TabIdRef}`, `logger`; Used by `engine::mod`,
     `engine::push_hook`.
   - Touch `engine/mod.rs`: delete the two functions, add `mod attention_decision;` and a
     `use`. The five `apply_attention_decision_*` tests move to the new file unchanged.
   - Tests: the moved tests pass unchanged; `cargo test -p yaran-core attention`.
2. **Pure edge tracker.**
   - Create `crates/yaran-core/src/cloud/push_edges.rs` (~200 lines incl. tests):
     `PushEdges`, `Edge { tab: TabId, kind: EdgeKind }`, `EdgeKind { Raised, Cleared }`
     (exhaustive). Header: Uses `engine::attention_decision`, `ids`; Used by
     `engine::push_hook`.
   - Tests: raise once per rising edge; repeated fire while flagged yields nothing;
     engaged suppresses; viewed then next tick yields `Cleared`; provider gone yields
     `Cleared`; disabled clears; re-raise after clear yields a second `Raised`.
3. **Engine hook (minimal wiring in the 12.6k-line `mod.rs`).**
   - Create `crates/yaran-core/src/engine/push_hook.rs` (~220 lines): `impl Engine {
     fn observe_push_tick(..); fn observe_push_bad_exit(..); fn push_event_for(..) }` and
     the exhaustive `project` match. Header: Uses `cloud::push_edges`,
     `cloud::push_emitter`, `cloud::protocol::Event`, `row_state`, `sanitize`,
     `tab_verdict`; Used by `engine::mod`.
   - Touch `engine/mod.rs`: `mod push_hook;`; two fields (`push_edges: PushEdges`,
     `push_emitter: PushEmitter`); `poll_agent_signals` drops `&& enabled` at `:1993`
     (the existing disabled test still holds because the decision clears) and calls
     `self.observe_push_tick(&fired, now)` after `:2007`; `mark_tab_run_failed` calls
     `self.observe_push_bad_exit(tab_id, &ending)` before the insert;
     `retune_after_config_swap` calls `self.push_emitter.retune(&self.config.cloud)`.
   - Touch the three struct-literal sites (`yaran-web/src/bootstrap.rs:195`,
     `yaran-tui/src/app/mod.rs:4250`, `engine/test_support.rs:121`) to construct the two
     fields, passing `worker_tx.clone()` as the status lane, beside `config_writer`.
   - Tests (in `push_hook.rs`, using `test_support` and `seed_signaling_provider`):
     indicator off + push on still emits; indicator on + push off emits nothing;
     bad exit emits an `ExitEvent` with `wire_kind` and no `state`, skipped when engaged;
     raise carries `needs_attention` and a clear carries the post-clear RowState token
     (`idle` for a vanished session); the first tab omits `tab_id` and an extra tab sends
     it, including after a first-tab promotion moves the pointer; every event has a
     distinct `id`; standalone agent sends the folder name, never `"unknown"`; label
     truncated by chars with a multi-byte name; `observe_push_tick` never blocks with a
     full channel (counts the drop).
4. **Queue and coalescer (pure).**
   - Create `crates/yaran-core/src/cloud/push_queue.rs` (~300 lines incl. tests):
     `PushQueue::{offer, due(now, max_batch) -> Vec<Event>, ack(ids), nack, expire(now),
     discard_all}`, time injected. Header: Uses `cloud::protocol`; Used by
     `cloud::push_emitter`.
   - Tests: raise+clear inside window sends nothing; raise after window sends once;
     clear sent only if raise was acknowledged; exit never coalesced; capacity drops
     oldest; TTL expiry counts; batch ≤ `max_batch` ≤ 16; a nacked event keeps its `id`;
     ids in `duplicates` count as acknowledged.
5. **Emitter thread.**
   - Create `crates/yaran-core/src/cloud/push_emitter.rs` (~380 lines): `PushEmitter`
     handle (`offer`, `retune`, `Drop`), the `cloud-push` thread loop
     (`recv_timeout` until the next due time), the `MachineConfig` cache and recheck,
     response classification as an exhaustive enum (`Delivered{accepted, duplicates}`,
     `Paused`, `Retry{after}`, `DropBatch`, `Revoked`, `ClockSkew`), the `min_interval_ms`
     spacing, the shutdown flush. Header: Uses `cloud::push_queue`, `cloud::credentials` (09),
     `cloud::signed_http` (09), `cloud::protocol`, `watch::rule::WatchBackoff`,
     `statusline`, `wire::status_keys`, `worker::WorkerEvent`, `sanitize`; External
     `std::sync::mpsc`, `std::thread`, `tracing`; Used by `engine::mod`,
     `engine::push_hook`.
   - Touch `crates/yaran-core/src/wire.rs`: add `CLOUD_PUSH` to `status_keys`.
   - Touch `crates/yaran-core/src/cloud/mod.rs` (09's file): three `mod` lines.
   - Tests: spawn failure falls back to "off" with a warning (inject the spawner like
     `ConfigWriteQueue::with_status_lane`); retune on/off idempotent; Drop joins within
     the bound.
6. **Config keys (through 09's checklist; Phase 19 hook H7).** Add to `[cloud]`:
   `push_coalesce_seconds` (u32, default 2, 0 = send every edge at once) and
   `push_offline_ttl_seconds` (u32, default 600, clamped 30..=86_400). H7 asks for the
   emitter's debounce and flush interval in `[cloud]`: `push_coalesce_seconds` is both,
   because the thread flushes an entry the moment its coalescing window ends (no separate
   timer); the only other spacing is the org's `events.min_interval_ms`, which is the
   Worker's to set, and 19 drives it through its test org. Touch, exactly as 09
   lists them: core `config.rs` struct + defaults + normalizers, the canonical commented
   renderer in `yaran-tui/src/config.rs` (inline comments also state that
   `push_notifications` is independent of `ui.attention_indicator`, that turning it off
   withdraws nothing already delivered, and what the phone is told), `config_write.rs`
   patch list, both reload owners via `retune_after_config_swap`. `config diff`
   exhaustiveness picks them up automatically. Tests: the existing exhaustiveness test,
   normalizer bounds.
7. **Integration test and hand-off facts.**
   - Create `crates/yaran-core/tests/cloud_push_emitter.rs` (~350 lines): a std
     `TcpListener` mock Worker (precedent `tests/release_notes_fetch.rs:49`) that
     verifies 02's signature headers against the test machine key using 02's shared
     fixtures, validates every body against 02's `EventBatch` schema, serves a scripted
     `MachineConfig`, and scripts responses: 202, 503×2 then 202 (retries, one delivery,
     same event ids), 202 with an id in `duplicates` (acknowledged), 429 + `Retry-After`,
     413 (dropped, no retry), 202 `push_enabled: false` (paused, queue discarded, resumes
     after a config recheck returns `push.enabled = true`), `push.detail = minimal`
     (bodies carry no `label`/`project`), `machine_revoked` (stops, status on the lane,
     verdict on 10's seam), `signature_expired` (skew status), offline beyond TTL (expiry
     status, then recovery info). Also asserts no request is made when unpaired.
   - Facts for 17, under 17's IDs: what leaves the machine (table above), when, to whom;
     machine event spoofing is covered by 02/04 signatures → **T28**; agent label/project
     disclosed to the org Worker in plaintext (accepted: the org's own infrastructure,
     D11, D17; `push.detail = minimal` is the opt-out) → **T59**; nothing past the Worker
     sees them (end-to-end encrypted push, Phase 08) → **T39**.

## Acceptance

- [ ] A raised edge in `yaran server`, the flip, plain TUI and TUI with
      `serve_while_tui` each produces exactly one signed `POST /v1/machine/events`
      (proved by the integration test plus one manual run per mode in Phase 19).
- [ ] With `ui.attention_indicator = false` and `push_notifications = true`, pushes still
      flow and the sidebar shows no attention.
- [ ] Raise then view within `push_coalesce_seconds` sends nothing.
- [ ] Exit prune, kill, detach, close-tab and delete each send `attention_cleared` for a
      previously raised tab; a bad exit sends `agent_exited_badly` with its `ending`.
- [ ] No request body contains terminal output, OSC text, paths other than a standalone
      folder's last component, or the machine key.
- [ ] Every request body validates against 02's `EventBatch` schema, carries RowState
      tokens (never prose) in `state`, and omits `label`/`project` while the org's
      `push.detail` is `minimal`; `push_enabled: false` pauses sending until the config
      says otherwise.
- [ ] The tick never blocks: full channel, dead network and a hung Worker all leave
      `poll_agent_signals` timing unchanged (test with a channel of size 1 and a mock that
      never answers).
- [ ] Revocation stops the emitter, notifies 10's seam, and shows the keyed warning on both
      surfaces.
- [ ] Every new file ≤ 500 lines with a passing `module-headers --check`.

## Validation

```bash
cd /Users/siavash/Projects/yaran
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test -p yaran-core attention
cargo test -p yaran-core push_
cargo test -p yaran-core --test cloud_push_emitter
cargo test -p yaran-core config     # includes the config diff exhaustiveness test
tools/module-headers/bin/module-headers --check   # Phase 01 entry point
wc -l crates/yaran-core/src/cloud/push_*.rs crates/yaran-core/src/engine/push_hook.rs \
      crates/yaran-core/src/engine/attention_decision.rs
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Push set and UI set disagree for one tick | Certain, harmless | Low | Same inputs and same function; documented above; test pins equality after two ticks |
| A bell-happy CLI raises and clears in a loop | Medium | Phone spam | Edges need view or exit in between; coalescing; Worker per-machine rate limit (08) |
| Offline laptop floods the phone on reconnect | Medium | Annoying | TTL 10 min; net-change coalescing collapses a tab's history to one state |
| 09's module names differ from those used here | Medium | Rework | One home per concept: use 09's names; this plan names roles, not new copies |
| Clock skew breaks signatures | Low | No pushes | 02's `signature_expired` (with `details.server_time`) surfaces a status with the offset |
| Process killed without `Drop` (reload exec, SIGKILL) leaves a raised notification on the phone | Medium | Stale notification | Phone shows age; Web Push TTL bounds undelivered ones; documented by 17 |
| D12 wording vs code | Resolved | Plan drift | D12 amended 2026-11-14 to the push-only set design above; a test pins push-set and UI-set equality after two ticks |
| Org turns push off and back on while the machine is paused | Medium | Up to 15 min of missed pushes | `CONFIG_RECHECK` named constant; a `retune` (config reload) rechecks at once |

## References

- `research/R1-server-core-cli.md` §5a–5e (attention), §9a (statusline); every line above
  re-verified on 2026-11-14.
- 00-README.md D5, D6, D11, D12, flow 5; 00-CONVENTIONS.md §1–§5.
- Phase 02 (`EventBatch`/`Event`/`EventBatchResult`, `MachineConfig`, signing, error codes), 08 (Worker side), 09, 10, 16, 17 (T28, T39, T59), 19 (hook H7).
- RFC 8030 §5.4 (Topic replacement makes duplicates collapse):
  https://www.rfc-editor.org/rfc/rfc8030.html (accessed 2026-11-14).

## Reconciliation notes (2026-11-14)

- R10/D12: "Decision conflict reported" section reworded to describe the push-only set as the adopted D12 design (README amended); the D12 Risk row marked resolved.
- 02: `MachineEvent` → `Event` (`AttentionEvent` | `ExitEvent`) inside `EventBatch`; Depends-on and References name 02's schemas.
- 02/R9: event fields renamed (`agent_label` → `label`, `place` → `project`, exit `status` → `exit_status`); `ts` is a 02 `Timestamp`, not Unix seconds; `id` (UUID v4 idempotency key, kept across retries) added.
- 02/R9: `state` is a RowState token: `needs_attention` on raise (was `needs_you`), the post-clear `agent_row_state(..)` token on clear (`idle` when unknown), absent on exit events; the "For 02" requests removed (02 now defines both the token and the batched body).
- 02: `tab_id` omitted for the agent's first tab, decided by `slot_tab_id()` (02's Event schema); test added.
- R9: batched body is always `EventBatch`; `EventBatchResult` handling added (`accepted` and `duplicates` acknowledge; `push_enabled: false` pauses).
- 02 `MachineConfig` (new design here): the thread fetches W5 at start, on retune and every 15 min while paused, honouring `push.enabled`, `push.detail = minimal` (drops `label`/`project`) and `events.{max_batch, min_interval_ms}`; tests and a Risk row added.
- 02 error codes: "clock-skew code" → `signature_expired` (`details.server_time`); `422` (not in 02) → "any other non-retryable 4xx"; `machine_unknown` 401 and `machine_revoked` 410 spelled; retries re-sign per 02 §7 (fresh nonce).
- 02 §9: duplicate collapse cites `topic(m, a, t)` instead of "08's per-tab Topic"; unpair (`POST /v1/machine/unpair`, 09) interaction stated.
- R15/R20: Phase 19 hook H7 (emitter debounce and flush interval in `[cloud]`) mapped to `push_coalesce_seconds` in work item 6.
- R14: hand-off facts carry T28 (event spoofing), T59 (plaintext metadata at the Worker), T39 (nothing past the Worker).
- Acceptance: added one criterion for `EventBatch` schema validity, token `state`, `detail = minimal` and the pause (no criterion removed).
