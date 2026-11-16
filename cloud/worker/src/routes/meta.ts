/**
 * `GET /v1/meta` (W1): the public, cacheable description of this control plane, served
 * before and after setup (D19).
 *
 * Before setup it says only what the service is, which protocol versions it speaks, that
 * setup is open, and the Worker version. Once setup is closed it adds the org, the Access
 * team domain, the capabilities and the push switch with the org's VAPID public key.
 *
 * - Public (07's override); reveals nothing about users, machines or other settings.
 * - `Cache-Control: public, max-age=60`, the one cacheable `/v1/*` answer (02 §2).
 *
 * <module-headers:begin>
 * Uses:
 * src/routes/meta.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/registry/capabilities.json
 * ├── src/routes/call.ts
 * └── src/update/worker-version.ts
 * External: none
 *
 * Used by:
 * src/routes/meta.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import { PROTOCOL_MAX, PROTOCOL_MIN, type Meta } from "@yaran/protocol";
import capabilities from "@yaran/protocol/registry/capabilities.json" with { type: "json" };
import { WORKER_VERSION } from "../update/worker-version.ts";
import type { Handler, RouteRow } from "./call.ts";

const getMeta: Handler = async ({ ctx }) => {
  const internal = await ctx.settings.internal();
  const meta: Meta = {
    service: "yaran-cloud",
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    setup: internal.setupState,
    worker: { version: WORKER_VERSION },
  };
  if (internal.setupState === "closed" && internal.controlPlaneHost && internal.teamDomain) {
    const settings = await ctx.settings.read();
    meta.org = { name: settings.org_name, url: `https://${internal.controlPlaneHost}` };
    meta.access = { team_domain: internal.teamDomain };
    meta.capabilities = [...capabilities.capabilities];
    meta.push = { enabled: settings.push.enabled, vapid_public_key: settings.push.enabled ? internal.vapidPublicKey : null };
  }
  return Response.json(meta, { headers: { "Cache-Control": "public, max-age=60" } });
};

export const META_ROUTES: RouteRow[] = [{ method: "GET", path: "/v1/meta", auth: { kind: "public" }, kind: "json", protocol: "none", handler: getMeta, rateLimit: "ip", bodyLimit: 0 }];
