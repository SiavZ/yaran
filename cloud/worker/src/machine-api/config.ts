/**
 * W5 `GET /v1/machine/config`: what a paired machine needs to run its cloud leg, 02's
 * `MachineConfig`, never the tunnel token.
 *
 * - Revoked and unknown machines never reach here: 04's pipeline answers `410
 *   machine_revoked` (after a valid signature) and `401 machine_unknown`.
 * - `tunnel.token_version` is 05's `tunnel_secret_generation`; a higher value than yaran
 *   holds makes it call W7 with reason `sync`.
 * - `last_seen_at` and `reported_protocol` are written at most once per 5 minutes.
 *
 * <module-headers:begin>
 * Uses:
 * src/machine-api/config.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/seams/context.ts
 * ├── src/seams/foundation.ts
 * └── src/shared/timestamp.ts
 * External: none
 *
 * Used by:
 * src/machine-api/config.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { MachineConfig } from "@yaran/protocol";
import { getMachine } from "../machines/machine-rows.ts";
import type { RouteCall, RouteRow } from "../seams/context.ts";
import { ApiError } from "../seams/foundation.ts";
import { toTimestamp } from "../shared/timestamp.ts";

export const CONFIG_SEEN_THROTTLE_S = 300;
/** Event batching the Worker asks of yaran (02 caps max_batch at 16). */
export const EVENTS = { max_batch: 16, min_interval_ms: 1000 } as const;

async function getConfig({ ctx, machine }: RouteCall): Promise<Response> {
  const m = await getMachine(ctx, machine!.id!);
  if (!m || m.hostname === null || m.tunnel_id === null || m.access_app_aud === null) {
    throw new ApiError("machine_not_ready", "This machine is still being set up. Try again in a minute.");
  }
  const [settings, internal] = await Promise.all([ctx.settings.read(), ctx.settings.internal()]);
  const owner = await ctx.db.prepare("SELECT email FROM users WHERE id = ?").bind(m.owner_user_id).first<{ email: string }>();
  const now = ctx.now();
  await ctx.db
    .prepare("UPDATE machines SET last_seen_at = ?, reported_protocol = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ? OR reported_protocol IS NOT ?)")
    .bind(now, machine!.protocol, m.id, now - CONFIG_SEEN_THROTTLE_S, machine!.protocol)
    .run();
  const config: MachineConfig = {
    machine_id: m.id,
    hostname: m.hostname,
    url: `https://${m.hostname}`,
    origin_port: m.origin_port,
    access: { team_domain: internal.teamDomain!, aud: m.access_app_aud },
    tunnel: { id: m.tunnel_id, token_version: m.tunnel_secret_generation },
    owner_email: owner!.email,
    push: { enabled: settings.push.enabled, detail: settings.push.detail },
    events: { ...EVENTS },
    server_time: toTimestamp(now),
  };
  return Response.json(config, { headers: { "Cache-Control": "no-store" } });
}

export const CONFIG_ROUTE: RouteRow = {
  method: "GET",
  path: "/v1/machine/config",
  auth: { kind: "machine", key: "registered" },
  kind: "json",
  handler: getConfig,
  rateLimit: "RL_MACHINE",
  bodyLimit: 0,
};
