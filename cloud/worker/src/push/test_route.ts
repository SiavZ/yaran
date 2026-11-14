/**
 * W15 `POST /v1/me/devices/{id}/test`: queues one `test` push to the caller's own device.
 *
 * Registered on 04's route table with auth `{kind:"user"}` and capability
 * `devices.test_push`. Another user's (or a revoked) device is 404 not_found, so ids cannot
 * be probed (T34); org push off is 409 push_disabled. The push goes through the same queue
 * as event pushes with Urgency normal, TTL 300 and no Topic.
 *
 * <module-headers:begin>
 * Uses:
 * cloud/worker/src/push/test_route.ts
 * ├── cloud/worker/src/push/seams.ts
 * ├── cloud/worker/src/push/settings.ts
 * └── cloud/worker/src/push/store.ts
 * External: @yaran/protocol
 *
 * Used by:
 * cloud/worker/src/push/test_route.ts
 * ├── cloud/worker/src/push/index.ts
 * └── yaran-worker-push-tests:events_route.test.ts
 * <module-headers:end>
 */
import { pushDelivery, testPayload } from "@yaran/protocol";
import type { PushDeps, RouteResult } from "./seams.ts";
import { pushSettings } from "./settings.ts";
import { bumpStats, ownedDevice } from "./store.ts";

export async function handleTestPush(deps: PushDeps, userId: string, deviceId: string): Promise<RouteResult> {
  const id = await ownedDevice(deps.db, userId, deviceId);
  if (!id) return { kind: "error", code: "not_found", message: "No such device." };
  const settings = pushSettings(await deps.readSettings());
  if (!settings.enabled) return { kind: "error", code: "push_disabled", message: "Push notifications are turned off for this organization." };
  const now = deps.now();
  const delivery = pushDelivery("test", settings.ttl_seconds);
  await deps.queue.sendBatch([{ body: { device_id: id, payload: testPayload(now), urgency: delivery.urgency, topic: null, ttl: delivery.ttl, enqueued_at: now } }]);
  await bumpStats(deps.db, now, { accepted: 1 });
  await deps.audit("device.test_push", id);
  return { kind: "empty", status: 202 };
}
