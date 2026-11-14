/**
 * W6 `POST /v1/machine/events`: a signed machine's batch of attention and exit events.
 *
 * Registered on 04's route table behind the signed-machine middleware (auth
 * `{kind:"machine", key:"registered"}`), which hands over the verified machine id and owner.
 * Order: per-machine rate limit (MACHINE_EVENTS, 429 with Retry-After), 02's EventBatch
 * validation (at most 16 events), 24 h dedupe by event id, the org's push switch, fan-out.
 * Answers 202 EventBatchResult in every accepted case, push off included.
 *
 * - A queue failure releases the batch's new event ids and answers 503, so the machine's
 *   retry is not swallowed as a duplicate.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/events_route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/fanout.ts
 * ├── src/push/settings.ts
 * ├── src/push/store.ts
 * └── src/push/types.ts
 * External: none
 *
 * Used by:
 * src/push/events_route.ts
 * ├── src/push/routes.ts
 * └── test/push/events_route.test.ts
 * <module-headers:end>
 */
import { validate, type EventBatch, type EventBatchResult } from "@yaran/protocol";
import { fanOut, type MachineIdentity } from "./fanout.ts";
import type { PushDeps, RateLimiter, RouteResult } from "./types.ts";
import { pushSettings } from "./settings.ts";
import { bumpStats, claimEventIds, releaseEventIds } from "./store.ts";

export const EVENTS_RETRY_AFTER_S = 60;

export async function handleEvents(
  deps: PushDeps & { machineEvents: RateLimiter },
  machine: MachineIdentity,
  body: unknown,
): Promise<RouteResult> {
  if (!(await deps.machineEvents.limit({ key: machine.id })).success) {
    return { kind: "error", code: "rate_limited", message: "This machine sent too many event batches; retry after a minute.", retryAfter: EVENTS_RETRY_AFTER_S };
  }
  const checked = validate("EventBatch", body);
  if (!checked.valid) {
    return { kind: "error", code: "validation_failed", message: "The event batch does not match EventBatch.", details: { errors: checked.errors } };
  }
  const { events } = body as EventBatch;
  const now = deps.now();
  const fresh = await claimEventIds(deps.db, machine.id, events.map((e) => e.id), now);
  const accepted = events.filter((e) => fresh.has(e.id));
  const result: EventBatchResult = {
    accepted: accepted.map((e) => e.id),
    duplicates: events.filter((e) => !fresh.has(e.id)).map((e) => e.id),
    push_enabled: false,
  };
  const settings = pushSettings(await deps.readSettings());
  if (!settings.enabled) return { kind: "json", status: 202, body: result };
  result.push_enabled = true;
  if (accepted.length === 0) return { kind: "json", status: 202, body: result };
  try {
    const queued = await fanOut(deps, machine, accepted, settings, now);
    await bumpStats(deps.db, now, { accepted: queued });
  } catch (err) {
    await releaseEventIds(deps.db, machine.id, result.accepted);
    deps.log.error("push.enqueue_failed", { machine_id: machine.id, reason: err instanceof Error ? err.message : String(err) });
    return { kind: "error", code: "unavailable", message: "The push queue is unavailable; retry the batch.", retryAfter: EVENTS_RETRY_AFTER_S };
  }
  return { kind: "json", status: 202, body: result };
}
