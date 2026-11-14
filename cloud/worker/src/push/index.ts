/**
 * Public surface of the org Worker's push module (Phase 08), and the wiring 04's files add.
 *
 * Wiring (one line each in 04's files; the module owns everything else):
 * - `http/routes.ts`: `{ method: "POST", path: "/v1/machine/events", auth: { kind: "machine",
 *   key: "registered" }, kind: "json", handler: (c) => handleEvents(pushDeps(c), c.machine, body) }`
 *   and `{ method: "POST", path: "/v1/me/devices/:id/test", auth: { kind: "user" }, kind: "json",
 *   handler: (c) => handleTestPush(pushDeps(c), c.user.id, c.params.id) }` (capability
 *   `devices.test_push`).
 * - `index.ts`: `queue: (batch, env, ctx) => consumePushBatch(pushDeps(env, ctx), batch.messages)`.
 * - `scheduled/tasks.ts`: `push_purge_event_ids` every 10 min → `purgeEventIds(db, now)`.
 * - 06's device registration calls `checkPushEndpoint` before storing a subscription.
 * - `wrangler.jsonc`:
 *   "queues": { "producers": [{ "binding": "PUSH_QUEUE", "queue": "yaran-push" }],
 *     "consumers": [{ "queue": "yaran-push", "max_batch_size": 10, "max_retries": 8, "max_batch_timeout": 5 }] },
 *   // max_batch_size 10 keeps a Free-plan consumer under 50 subrequests; max_retries must
 *   // equal consumer.ts MAX_RETRIES; no dead-letter queue (an exhausted push is counted, then acked).
 *   "ratelimits": [{ "name": "MACHINE_EVENTS", "namespace_id": "7708", "simple": { "limit": 60, "period": 60 } }]
 *   // W6 batches per machine id per minute.
 *
 * <module-headers:begin>
 * Uses:
 * cloud/worker/src/push/index.ts
 * ├── cloud/worker/src/push/consumer.ts
 * ├── cloud/worker/src/push/endpoint_policy.ts
 * ├── cloud/worker/src/push/events_route.ts
 * ├── cloud/worker/src/push/seams.ts
 * ├── cloud/worker/src/push/settings.ts
 * ├── cloud/worker/src/push/store.ts
 * └── cloud/worker/src/push/test_route.ts
 * External: none
 *
 * Used by: entry point (push module surface, imported by Phase 04's cloud/worker/src/index.ts and http/routes.ts when they land)
 * <module-headers:end>
 */
export { consumePushBatch, MAX_RETRIES } from "./consumer.ts";
export { checkPushEndpoint, type EndpointContext, type EndpointVerdict } from "./endpoint_policy.ts";
export { handleEvents } from "./events_route.ts";
export type { D1Like, PushDeps, PushJob, PushQueue, QueueMessage, RateLimiter, RouteResult } from "./seams.ts";
export { DEFAULT_PUSH_SETTINGS, pushSettings } from "./settings.ts";
export { purgeEventIds } from "./store.ts";
export { handleTestPush } from "./test_route.ts";
