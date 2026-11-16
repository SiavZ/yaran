/**
 * Builds the push module's `PushDeps` from 04's `AppContext`: D1, the `PUSH_QUEUE`
 * binding, the logger, the `push` settings row, 04's data key for the sealed device columns
 * and 07's sealed VAPID key, the control-plane origin and the audit writer.
 *
 * - The VAPID private key is opened only when a batch needs to sign; it never leaves here
 *   but as the JWK the signer imports.
 * - Without the `MACHINE_EVENTS` Rate Limiting binding (plan availability UNVERIFIED), the
 *   per-machine event limit falls back to a strict D1 counter.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/deps.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/audit/audit.ts
 * ├── src/db/settings.ts
 * ├── src/http/context.ts
 * ├── src/push/types.ts
 * ├── src/security/data-key.ts
 * ├── src/security/rate-limit.ts
 * └── src/setup/steps/keys.ts
 * External: none
 *
 * Used by:
 * src/push/deps.ts
 * ├── src/index.ts
 * ├── src/push/routes.ts
 * └── test/push/helpers/fakes.ts
 * <module-headers:end>
 */
import { utf8Decode } from "@yaran/protocol";
import { record } from "../audit/audit.ts";
import { getSettings, getStoredSettings } from "../db/settings.ts";
import type { AppContext } from "../http/context.ts";
import { open } from "../security/data-key.ts";
import { strictHit } from "../security/rate-limit.ts";
import { VAPID_AAD } from "../setup/steps/keys.ts";
import type { PushDeps, PushQueue, RateLimiter } from "./types.ts";

/** W6 event batches per machine id per minute (the MACHINE_EVENTS binding's own limit). */
export const MACHINE_EVENTS_PER_MINUTE = 60;

function queueOf(env: Cloudflare.Env): PushQueue {
  const q = (env as unknown as { PUSH_QUEUE?: PushQueue }).PUSH_QUEUE;
  if (!q) throw new Error("the PUSH_QUEUE binding is missing; add the queues block of wrangler.jsonc");
  return q;
}

/** The per-machine W6 limiter: the binding when the deploy has it, else a D1 counter. */
export function machineEventsLimiter(ctx: AppContext): RateLimiter {
  const binding = (ctx.env as unknown as { MACHINE_EVENTS?: RateLimiter }).MACHINE_EVENTS;
  if (binding && typeof binding.limit === "function") return binding;
  return {
    limit: async ({ key }) => ({ success: (await strictHit(ctx.db, `push:events:${key}`, MACHINE_EVENTS_PER_MINUTE, 60, ctx.now())).ok }),
  };
}

export async function pushDeps(ctx: AppContext, o: { fetch?: typeof fetch; queue?: PushQueue } = {}): Promise<PushDeps> {
  const host = (await getSettings(ctx.db, ["control_plane_host"])).control_plane_host;
  return {
    db: ctx.db,
    get queue() {
      return o.queue ?? queueOf(ctx.env);
    },
    log: ctx.log,
    readSettings: async () => (await getStoredSettings(ctx.db, ["push"]))["push"],
    openDeviceSecret: async (deviceId, column, sealed) =>
      utf8Decode(await open(ctx, column === "endpoint_enc" ? "device_endpoint" : "device_auth", { table: "devices", column, rowId: deviceId }, sealed)) ?? "",
    vapidKey: async () => {
      const s = await getSettings(ctx.db, ["vapid_public_key", "vapid_private_key_enc"]);
      if (!s.vapid_public_key || !s.vapid_private_key_enc) throw new Error("the org VAPID key has not been generated; finish the setup wizard's keys step");
      const jwk = utf8Decode(await open(ctx, "vapid", VAPID_AAD, s.vapid_private_key_enc));
      return { privateJwk: JSON.parse(jwk ?? "{}") as JsonWebKey, publicKey: s.vapid_public_key };
    },
    selfOrigin: `https://${host ?? "localhost"}`,
    audit: (action, deviceId, detail) => record(ctx, { action, target: { kind: "device", id: deviceId }, outcome: "ok", ...(detail ? { detail } : {}) }),
    now: () => ctx.now(),
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
  };
}
