/**
 * The push module's route rows for 04's table (W6 machine events, the device test push)
 * and its cron task for 04's registry.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/routes.ts
 * ├── src/http/body.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * ├── src/http/routes.ts
 * ├── src/push/deps.ts
 * ├── src/push/events_route.ts
 * ├── src/push/store.ts
 * ├── src/push/test_route.ts
 * ├── src/push/types.ts
 * └── src/scheduled/tasks.ts
 * External: none
 *
 * Used by:
 * src/push/routes.ts
 * ├── src/http/routes.ts
 * ├── src/scheduled/tasks.ts
 * └── test/push/routes.test.ts
 * <module-headers:end>
 */
import { parseJsonBytes } from "../http/body.ts";
import { requireMachine, requireUser } from "../http/context.ts";
import { HttpError, json } from "../http/responses.ts";
import type { Route } from "../http/routes.ts";
import { machineEventsLimiter, pushDeps } from "./deps.ts";
import { handleEvents } from "./events_route.ts";
import { handleTestPush } from "./test_route.ts";
import type { TaskDef } from "../scheduled/tasks.ts";
import { purgeEventIds } from "./store.ts";
import type { RouteResult } from "./types.ts";

/** A push outcome as a response; an error is thrown for the pipeline's 02 envelope. */
export function respond(r: RouteResult): Response {
  switch (r.kind) {
    case "json":
      return json(r.body, r.status);
    case "empty":
      return new Response(null, { status: r.status });
    case "error":
      throw new HttpError(r.code, r.message, {
        ...(r.details ? { details: r.details } : {}),
        ...(r.retryAfter === undefined ? {} : { headers: { "Retry-After": String(r.retryAfter) } }),
      });
  }
}

/** Spread into 04's `scheduled/tasks.ts`: the 24 h event-id dedupe window, a slice per run. */
export const PUSH_TASKS: readonly TaskDef[] = [
  {
    name: "push_purge_event_ids", intervalS: 600, priority: 50, cost: { queries: 1, subrequests: 0 },
    run: async (ctx) => ({ more: (await purgeEventIds(ctx.db, ctx.now())) >= 500 }),
  },
];

export const PUSH_ROUTES: readonly Route[] = [
  {
    method: "POST", path: "/v1/machine/events", auth: { kind: "machine", key: "registered" }, kind: "json", protocol: "header", rateLimit: "machine",
    handler: async (ctx) => {
      const m = requireMachine(ctx);
      if (!m.machine) throw new HttpError("machine_unknown");
      const deps = { ...(await pushDeps(ctx)), machineEvents: machineEventsLimiter(ctx) };
      return respond(await handleEvents(deps, { id: m.machine.id, ownerUserId: m.machine.owner_user_id }, parseJsonBytes(ctx.body)));
    },
  },
  {
    // Capability devices.test_push.
    method: "POST", path: "/v1/me/devices/:id/test", auth: { kind: "user" }, kind: "json", protocol: "header", rateLimit: "auth",
    handler: async (ctx) => respond(await handleTestPush(await pushDeps(ctx), requireUser(ctx).user.id, ctx.params["id"] ?? "")),
  },
];
