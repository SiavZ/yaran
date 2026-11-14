/**
 * W32 `PUT /v1/machine/origin` (R9): yaran reports the loopback port it serves on when it
 * differs from `MachineConfig.origin_port`; 05's `setOriginPort` repairs the ingress
 * (step P4 only, async).
 *
 * - The same port answers `202 {changed:false}` with no 05 call.
 * - Out of range is `origin_port_invalid`; a machine with a live op is
 *   `409 provisioning_in_progress` (05 refuses).
 *
 * <module-headers:begin>
 * Uses:
 * src/machine-api/origin.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/seams/context.ts
 * └── src/shared/json-body.ts
 * External: none
 *
 * Used by:
 * src/machine-api/origin.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { OriginUpdate, OriginUpdateResult } from "@yaran/protocol";
import { getMachine } from "../machines/machine-rows.ts";
import type { RouteCall, RouteRow } from "../seams/context.ts";
import { checkOriginPortField, parseJson, validated } from "../shared/json-body.ts";

async function putOrigin({ ctx, body, machine }: RouteCall): Promise<Response> {
  const raw = parseJson(body);
  checkOriginPortField(raw);
  const req = validated<OriginUpdate>("OriginUpdate", raw);
  const id = machine!.id!;
  const m = await getMachine(ctx, id);
  let answer: OriginUpdateResult = { origin_port: req.origin_port, changed: false };
  if (m && m.origin_port !== req.origin_port) {
    await ctx.provisioning.setOriginPort(id, req.origin_port);
    await ctx.db.prepare("UPDATE machines SET origin_port = ? WHERE id = ?").bind(req.origin_port, id).run();
    await ctx.audit.record({ action: "machine.origin_changed", actor: { kind: "machine", id }, target: { kind: "machine", id }, outcome: "ok", detail: { from: m.origin_port, to: req.origin_port } });
    answer = { origin_port: req.origin_port, changed: true };
  }
  return Response.json(answer, { status: 202, headers: { "Cache-Control": "no-store" } });
}

export const ORIGIN_ROUTE: RouteRow = {
  method: "PUT",
  path: "/v1/machine/origin",
  auth: { kind: "machine", key: "registered" },
  kind: "json",
  handler: putOrigin,
  rateLimit: "RL_MACHINE",
  bodyLimit: 1024,
};
