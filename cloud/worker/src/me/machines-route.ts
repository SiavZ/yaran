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
 * ├── src/http/responses.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/machines/machine-view-model.ts
 * ├── src/me/cursor.ts
 * └── src/routes/call.ts
 * External: none
 *
 * Used by:
 * src/me/machines-route.ts
 * ├── src/admin/pairing-service.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { MachinePage, TeardownStarted } from "@yaran/protocol";
import { getOwnedMachine, listOwnedMachines } from "../machines/machine-rows.ts";
import { machineSummary } from "../machines/machine-view-model.ts";
import type { Phase06Ctx, RouteCall, RouteRow } from "../routes/call.ts";
import { HttpError } from "../http/responses.ts";
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

/** W11's core, shared with 07's console: starts the owner's unpair; false for no such live machine. */
export async function unpairOwnedMachine(ctx: Phase06Ctx, userId: string, machineId: string): Promise<boolean> {
  const row = await getOwnedMachine(ctx, machineId, userId);
  if (!row || row.status === "revoked") return false;
  if (row.status !== "revoking") {
    await ctx.provisioning.startTeardown(row.id, "user_unpair");
    await ctx.audit.record({
      action: "machine.unpaired",
      actor: { kind: "user", id: userId },
      target: { kind: "machine", id: row.id },
      outcome: "ok",
      detail: { reason: "user_unpair" },
    });
  }
  return true;
}

async function deleteMachine({ ctx, user, params }: RouteCall): Promise<Response> {
  const id = params["id"] ?? "";
  if (!(await unpairOwnedMachine(ctx, user!.userId, id))) throw new HttpError("not_found", "No machine with that id is paired to your account.");
  const body: TeardownStarted = { machine_id: id, state: "tearing_down" };
  return Response.json(body, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export const MY_MACHINE_ROUTES: RouteRow[] = [
  { method: "GET", path: "/v1/me/machines", auth: { kind: "user" }, kind: "json", protocol: "header", handler: listMachines, rateLimit: "ip", bodyLimit: 0 },
  { method: "DELETE", path: "/v1/me/machines/:id", auth: { kind: "user" }, kind: "json", protocol: "header", handler: deleteMachine, rateLimit: "ip", bodyLimit: 0 },
];
