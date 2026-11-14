/**
 * The user's machine routes: `GET /v1/me/machines` (W10) and
 * `DELETE /v1/me/machines/{id}` (W11).
 *
 * The list reads D1 only (05's reconciliation cache is on the row), so it costs zero
 * Cloudflare API calls however often a console or phone polls it. The delete hands the
 * machine to 05's ordered teardown and answers at once.
 *
 * - Ownership is part of every query; another user's id is `404`, never `403` (T34).
 * - A machine already tearing down answers `202` again without a second teardown, so a
 *   retried delete is harmless.
 *
 * <module-headers:begin>
 * Uses:
 * src/me/machines-route.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/me/cursor.ts
 * ├── src/seams/context.ts
 * └── src/seams/foundation.ts
 * External: none
 *
 * Used by:
 * src/me/machines-route.ts
 * ├── src/routes/pairing-and-sessions.ts
 * ├── test/devices/devices-route.test.ts
 * └── test/me/machines-route.test.ts
 * <module-headers:end>
 */
import type { MachinePage, TeardownStarted } from "@yaran/protocol";
import { getOwnedMachine, listOwnedMachines } from "../machines/machine-rows.ts";
import { machineSummary } from "../machines/machine-view-model.ts";
import type { RouteCall, RouteRow } from "../seams/context.ts";
import { ApiError } from "../seams/foundation.ts";
import { nextCursor, pageQuery } from "./cursor.ts";

async function listMachines({ req, ctx, user }: RouteCall): Promise<Response> {
  const { limit, after } = pageQuery(new URL(req.url));
  const rows = await listOwnedMachines(ctx, user!.userId, limit, after);
  const now = ctx.now();
  const page: MachinePage = {
    items: rows.map((r) => machineSummary(r, now)).filter((s) => s !== null),
    next_cursor: nextCursor(rows, limit),
  };
  return Response.json(page, { headers: { "Cache-Control": "no-store" } });
}

async function deleteMachine({ ctx, user, params }: RouteCall): Promise<Response> {
  const row = await getOwnedMachine(ctx, params["id"] ?? "", user!.userId);
  if (!row || row.status === "revoked") throw new ApiError("not_found", "No machine with that id is paired to your account.");
  if (row.status !== "revoking") {
    await ctx.provisioning.startTeardown(row.id, "user_unpair");
    await ctx.audit.record({
      action: "machine.unpaired",
      actor: { kind: "user", id: user!.userId },
      target: { kind: "machine", id: row.id },
      outcome: "ok",
      detail: { reason: "user_unpair" },
    });
  }
  const body: TeardownStarted = { machine_id: row.id, state: "tearing_down" };
  return Response.json(body, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export const MY_MACHINE_ROUTES: RouteRow[] = [
  { method: "GET", path: "/v1/me/machines", auth: { kind: "user" }, kind: "json", handler: listMachines, rateLimit: "RL_IP", bodyLimit: 0 },
  { method: "DELETE", path: "/v1/me/machines/:id", auth: { kind: "user" }, kind: "json", handler: deleteMachine, rateLimit: "RL_IP", bodyLimit: 0 },
];
