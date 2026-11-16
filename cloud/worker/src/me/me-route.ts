/**
 * `GET /v1/me` (W9): who the caller is, the org, their caps and counts, and the
 * verified control-plane JWT's expiry.
 *
 * `session_exp` is what the phone schedules renewal from (Phase 15): an expired call is
 * answered by Access before the Worker runs, so the Worker can only publish `exp` early.
 *
 * - Reads D1 and settings only; writes nothing.
 *
 * <module-headers:begin>
 * Uses:
 * src/me/me-route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/http/responses.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/routes/call.ts
 * └── src/shared/timestamp.ts
 * External: none
 *
 * Used by:
 * src/me/me-route.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { Me } from "@yaran/protocol";
import { countLiveMachines } from "../machines/machine-rows.ts";
import type { Handler, RouteRow } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";
import { toTimestamp } from "../shared/timestamp.ts";

const getMe: Handler = async ({ ctx, user }) => {
  if (!user) throw new HttpError("unauthenticated", "This route needs a signed-in user.");
  const [settings, internal] = await Promise.all([ctx.settings.read(), ctx.settings.internal()]);
  if (!internal.controlPlaneHost) throw new HttpError("setup_incomplete", "Setup has not recorded the control-plane host yet.");
  const devices = await ctx.db.prepare("SELECT count(*) AS n FROM devices WHERE user_id = ? AND revoked_at IS NULL").bind(user.userId).first<{ n: number }>();
  const me: Me = {
    email: user.email,
    session_exp: toTimestamp(user.exp),
    role: user.role,
    user_slug: user.slug,
    org: { name: settings.org_name, url: `https://${internal.controlPlaneHost}` },
    limits: { machines: settings.machine_cap_per_user, devices: settings.device_cap_per_user },
    counts: { machines: await countLiveMachines(ctx, user.userId), devices: devices?.n ?? 0 },
  };
  return Response.json(me, { headers: { "Cache-Control": "no-store" } });
};

export const ME_ROUTES: RouteRow[] = [{ method: "GET", path: "/v1/me", auth: { kind: "user" }, kind: "json", protocol: "header", handler: getMe, rateLimit: "ip", bodyLimit: 0 }];
