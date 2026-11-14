/**
 * Fan-out: turns a machine's accepted events into one queued push per eligible device of
 * the machine's owner.
 *
 * A device is eligible when it is subscribed and healthy (active or failing), not muted per
 * 02's rule (mute_all, muted_until, the machine in muted_machine_ids), and, for relay
 * channels, when the org allows relays and the relay is allowlisted. The payload is 02's,
 * with p and l stripped when `Settings.push.detail = minimal` (the server-side backstop for
 * a stale machine config); Topic and Urgency come from 02's topic() and delivery table.
 *
 * - Queues in chunks of 100 (the Queues sendBatch limit); throws when the queue refuses, so
 *   the caller can release the event ids for the machine's retry.
 * - The consumer re-checks every rule at send time, because mutes and state can change.
 *
 * <module-headers:begin>
 * Uses:
 * cloud/worker/src/push/fanout.ts
 * ├── cloud/worker/src/push/seams.ts
 * ├── cloud/worker/src/push/settings.ts
 * └── cloud/worker/src/push/store.ts
 * External: @yaran/protocol
 *
 * Used by:
 * cloud/worker/src/push/fanout.ts
 * └── cloud/worker/src/push/events_route.ts
 * <module-headers:end>
 */
import { eventToPayload, fitPushPayload, pushDelivery, pushTopic, type Event, type PushPayload } from "@yaran/protocol";
import type { PushDeps, PushJob, PushSettings } from "./seams.ts";
import { isMuted, relayVerdict } from "./settings.ts";
import { fanoutCandidates } from "./store.ts";

const SEND_BATCH_MAX = 100;

export interface MachineIdentity {
  id: string;
  ownerUserId: string;
}

/** The payload for an event under the org's detail setting. */
export function payloadFor(event: Event, machineId: string, settings: PushSettings): PushPayload {
  const payload = eventToPayload(event, machineId);
  if (settings.detail === "minimal") {
    delete payload.p;
    delete payload.l;
  }
  return payload;
}

/** Queues the pushes for accepted events; returns how many were queued. */
export async function fanOut(deps: PushDeps, machine: MachineIdentity, events: Event[], settings: PushSettings, now: number): Promise<number> {
  const candidates = await fanoutCandidates(deps.db, machine.ownerUserId, machine.id);
  const devices = candidates.filter(
    (d) => !isMuted(d, d.machine_muted, now) && relayVerdict(settings, d.channel, `https://${d.endpoint_host}`) === "ok",
  );
  if (devices.length === 0) return 0;
  const jobs: PushJob[] = [];
  for (const event of events) {
    const payload = payloadFor(event, machine.id, settings);
    if (fitPushPayload(payload) === null) {
      deps.log.error("push.payload_oversize", { event_id: event.id, machine_id: machine.id });
      continue;
    }
    const delivery = pushDelivery(payload.k, settings.ttl_seconds);
    const topic = delivery.topic ? await pushTopic(machine.id, event.agent_id, event.tab_id) : null;
    for (const d of devices) {
      jobs.push({ device_id: d.id, payload, urgency: delivery.urgency, topic, ttl: delivery.ttl, enqueued_at: now });
    }
  }
  for (let i = 0; i < jobs.length; i += SEND_BATCH_MAX) {
    await deps.queue.sendBatch(jobs.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body })));
  }
  return jobs.length;
}
