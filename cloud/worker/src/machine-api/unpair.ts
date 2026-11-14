/**
 * W8 `POST /v1/machine/unpair` (R8): yaran's `cloud logout`. Starts 05's ordered teardown
 * with reason `machine_logout` and answers `202 TeardownStarted`.
 *
 * - Idempotent by construction: once the machine is `revoking`, 04's pipeline answers
 *   every signed call, this one included, with `410 machine_revoked`; yaran deletes its
 *   credentials on 202 or 410.
 * - Lives under `/v1/machine/*`, never the bare prefix, so the one public override covers it.
 *
 * <module-headers:begin>
 * Uses:
 * src/machine-api/unpair.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/seams/context.ts
 * External: none
 *
 * Used by:
 * src/machine-api/unpair.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { TeardownStarted } from "@yaran/protocol";
import type { RouteCall, RouteRow } from "../seams/context.ts";

async function postUnpair({ ctx, machine }: RouteCall): Promise<Response> {
  const id = machine!.id!;
  await ctx.provisioning.startTeardown(id, "machine_logout");
  await ctx.audit.record({ action: "machine.unpaired", actor: { kind: "machine", id }, target: { kind: "machine", id }, outcome: "ok", detail: { reason: "machine_logout" } });
  const answer: TeardownStarted = { machine_id: id, state: "tearing_down" };
  return Response.json(answer, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export const UNPAIR_ROUTE: RouteRow = {
  method: "POST",
  path: "/v1/machine/unpair",
  auth: { kind: "machine", key: "registered" },
  kind: "json",
  handler: postUnpair,
  rateLimit: "RL_MACHINE",
  bodyLimit: 0,
};
