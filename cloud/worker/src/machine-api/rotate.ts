/**
 * W7 `POST /v1/machine/rotate`: `reason = user` rotates the tunnel secret now (05's
 * `rotateTunnelSecret`, old connectors left to drain); `reason = sync` hands back the
 * current token after yaran saw a higher `token_version` in its config.
 *
 * - The token is returned, never stored (04 §7). A rotation is audited as
 *   `machine.rotated` with the machine as actor; a sync is not a state change.
 *
 * <module-headers:begin>
 * Uses:
 * src/machine-api/rotate.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/routes/call.ts
 * └── src/shared/json-body.ts
 * External: none
 *
 * Used by:
 * src/machine-api/rotate.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { RotateRequest, RotateResponse } from "@yaran/protocol";
import type { RouteCall, RouteRow } from "../routes/call.ts";
import { parseJson, validated } from "../shared/json-body.ts";

async function postRotate({ ctx, body, machine }: RouteCall): Promise<Response> {
  const req = validated<RotateRequest>("RotateRequest", parseJson(body));
  const id = machine!.id!;
  let answer: RotateResponse;
  switch (req.reason) {
    case "user": {
      // 05's rotate op audits machine.rotated when it succeeds.
      answer = { tunnel: await ctx.provisioning.rotateTunnelSecret(id, { evict: false }), rotated: true };
      break;
    }
    case "sync":
      answer = { tunnel: await ctx.provisioning.fetchTunnelToken(id), rotated: false };
      break;
    default: {
      const never: never = req.reason;
      throw new Error(`unknown rotate reason ${String(never)}`);
    }
  }
  return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
}

export const ROTATE_ROUTE: RouteRow = {
  method: "POST",
  path: "/v1/machine/rotate",
  auth: { kind: "machine", key: "registered" },
  kind: "json", protocol: "header",
  handler: postRotate,
  rateLimit: "machine",
  bodyLimit: 1024,
};
