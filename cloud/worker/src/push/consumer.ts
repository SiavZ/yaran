/**
 * The PUSH_QUEUE consumer: encrypts and sends each queued push and turns the push service's
 * answer into an ack, a delayed retry or a device state change.
 *
 * One D1 read loads the batch's devices; every eligibility rule is re-checked because mutes,
 * settings and state may have changed since fan-out (a test push ignores mutes: the user
 * asked for it). 2xx marks the device active; 404/410 clears its subscription and marks it
 * gone (row kept, audited); 401/403 marks it auth_failed (audited); 400/413 and other
 * statuses are bugs, acked and logged; 429 and 5xx/network retry with Retry-After or
 * backoff. A retry past MAX_RETRIES or past the push's TTL is acked and counted; five in a
 * row turn the device failing (audited).
 *
 * - Logs carry the device id, push host, status and outcome; never the endpoint, keys,
 *   JWT or payload. Upstream body excerpts have the endpoint path redacted and are
 *   sanitized by 04's logger.
 * - An unexpected error (D1, crypto) retries the message rather than losing it.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/consumer.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/push/send.ts
 * ├── src/push/settings.ts
 * ├── src/push/store.ts
 * └── src/push/types.ts
 * External: none
 *
 * Used by:
 * src/push/consumer.ts
 * ├── src/index.ts
 * └── test/push/consumer.test.ts
 * <module-headers:end>
 */
import { b64urlDecode, encryptWebPush, fitPushPayload } from "@yaran/protocol";
import { classify, postPush, VapidCache, backoffSeconds, type PushResponse } from "./send.ts";
import type { PushDeps, PushJob, PushSettings, QueueMessage } from "./types.ts";
import { assertNever, isMuted, pushSettings, relayVerdict } from "./settings.ts";
import { bumpStats, loadSendDevices, markAuthFailed, markGone, markOk, recordExhausted, type SendDevice } from "./store.ts";

/** Must equal `max_retries` of the PUSH_QUEUE consumer in wrangler.jsonc. */
export const MAX_RETRIES = 8;
const EXCERPT_CHARS = 200;
const vapidCache = new VapidCache();

interface Tally {
  delivered: number;
  failed: number;
  gone: number;
}

interface BatchCtx {
  deps: PushDeps;
  settings: PushSettings;
  devices: Map<string, SendDevice>;
  now: number;
  tally: Tally;
  vapid: VapidCache;
}

/** The queue() handler body for one batch. */
export async function consumePushBatch(deps: PushDeps, messages: readonly QueueMessage<PushJob>[], vapid: VapidCache = vapidCache): Promise<void> {
  const now = deps.now();
  const tally: Tally = { delivered: 0, failed: 0, gone: 0 };
  let ctx: BatchCtx;
  try {
    const settings = pushSettings(await deps.readSettings());
    const devices = await loadSendDevices(deps.db, [...new Set(messages.map((m) => m.body.device_id))]);
    ctx = { deps, settings, devices, now, tally, vapid };
  } catch (err) {
    deps.log.error("push.batch_unreadable", { reason: reason(err), size: messages.length });
    for (const m of messages) m.retry({ delaySeconds: backoffSeconds(m.attempts) });
    return;
  }
  await Promise.all(
    messages.map(async (m) => {
      try {
        await handle(ctx, m);
      } catch (err) {
        deps.log.error("push.send_error", { device_id: m.body.device_id, reason: reason(err) });
        m.retry({ delaySeconds: backoffSeconds(m.attempts) });
      }
    }),
  );
  await bumpStats(deps.db, now, tally);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function eligible(ctx: BatchCtx, job: PushJob, d: SendDevice | undefined): string | null {
  if (!d || d.revoked || d.channel === "none" || !d.endpoint_enc || !d.endpoint_host || !d.p256dh || !d.auth_enc) return "no_subscription";
  if (d.push_state !== "active" && d.push_state !== "failing") return "push_state";
  if (!ctx.settings.enabled) return "push_disabled";
  if (job.payload.k !== "test" && isMuted(d, d.muted_machines.has(job.payload.m ?? ""), ctx.now)) return "muted";
  if (relayVerdict(ctx.settings, d.channel, `https://${d.endpoint_host}`) !== "ok") return "relay_disallowed";
  return null;
}

async function handle(ctx: BatchCtx, m: QueueMessage<PushJob>): Promise<void> {
  const { deps, now, tally } = ctx;
  const job = m.body;
  if (m.attempts > 1 && now > job.enqueued_at + job.ttl) return exhausted(ctx, m, "ttl_expired");
  const d = ctx.devices.get(job.device_id);
  const skip = eligible(ctx, job, d);
  if (skip || !d) {
    deps.log.info("push.skipped", { device_id: job.device_id, reason: skip });
    return m.ack();
  }
  const plaintext = fitPushPayload(job.payload);
  if (!plaintext) {
    deps.log.error("push.payload_oversize", { device_id: d.id, kind: job.payload.k });
    tally.failed++;
    return m.ack();
  }
  const endpoint = await deps.openDeviceSecret(d.id, "endpoint_enc", d.endpoint_enc!);
  const auth = b64urlDecode(await deps.openDeviceSecret(d.id, "auth_enc", d.auth_enc!));
  if (!auth || auth.length !== 16) throw new Error("the stored auth secret is not 16 bytes");
  const body = await encryptWebPush(plaintext, d.p256dh!, auth);
  const authorization = await ctx.vapid.header(deps, new URL(endpoint).origin, now);
  const res = await postPush(deps.fetch ?? fetch, endpoint, body, job, authorization, now);
  const outcome = classify(res.status, res.retryAfter, m.attempts, now);
  const fields = { device_id: d.id, push_host: d.endpoint_host, status: res.status, attempts: m.attempts, outcome: outcome.kind };
  switch (outcome.kind) {
    case "ok":
      await markOk(deps.db, d.id, now);
      tally.delivered++;
      deps.log.info("push.sent", fields);
      return m.ack();
    case "gone":
      if (await markGone(deps.db, d.id)) await deps.audit("device.push_gone", d.id, { status: res.status });
      tally.gone++;
      deps.log.info("push.gone", fields);
      return m.ack();
    case "auth_failed":
      if (await markAuthFailed(deps.db, d.id)) await deps.audit("device.push_auth_failed", d.id, { status: res.status });
      tally.failed++;
      deps.log.warn("push.auth_failed", fields);
      return m.ack();
    case "bug":
      tally.failed++;
      deps.log.error("push.rejected", { ...fields, body_excerpt: excerpt(res, endpoint) });
      return m.ack();
    case "retry":
      if (m.attempts > MAX_RETRIES) return exhausted(ctx, m, `status_${res.status}`);
      deps.log.warn("push.retry", { ...fields, delay_s: outcome.delaySeconds });
      return m.retry({ delaySeconds: outcome.delaySeconds });
    default:
      return assertNever(outcome);
  }
}

async function exhausted(ctx: BatchCtx, m: QueueMessage<PushJob>, why: string): Promise<void> {
  ctx.tally.failed++;
  ctx.deps.log.warn("push.exhausted", { device_id: m.body.device_id, attempts: m.attempts, reason: why });
  if (await recordExhausted(ctx.deps.db, m.body.device_id)) await ctx.deps.audit("device.push_failing", m.body.device_id);
  m.ack();
}

/** A short upstream body with the endpoint (a capability URL) cut out. */
function excerpt(res: PushResponse, endpoint: string): string {
  const path = new URL(endpoint).pathname;
  return res.text.split(endpoint).join("<endpoint>").split(path).join("<endpoint>").slice(0, EXCERPT_CHARS);
}
