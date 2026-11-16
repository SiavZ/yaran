/**
 * Rotate steps: replace the tunnel secret (returning the new token to the inline caller only)
 * and, for a "compromised" rotation, evict live connectors.
 *
 * A routine rotation leaves existing connectors up until yaran restarts cloudflared with the
 * new token (R4 §1.8); `evict` (W22 `kill_connections`) drops them at once.
 *
 * - The token is held in the drive's memory and never written to D1. If the inline caller
 *   loses it, yaran sees the higher `token_version` on W5 and fetches it through W7 `sync`.
 * - The generation bump is recorded in the same batch as the step advance.
 *
 * <module-headers:begin>
 * Uses:
 * src/provisioning/steps-rotate.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/engine.ts
 * ├── src/provisioning/ops-store.ts
 * └── src/provisioning/provision-error.ts
 * External: none
 *
 * Used by:
 * src/provisioning/steps-rotate.ts
 * └── src/provisioning/engine.ts
 * <module-headers:end>
 */
import { deleteTunnelConnections, randomTunnelSecret, rotateTunnelSecret } from "../cloudflare/tunnels.ts";
import type { StepFn } from "./engine.ts";
import type { RotateStep } from "./ops-store.ts";
import { ProvisionError } from "./provision-error.ts";

const rotateSecret: StepFn = async ({ ctx, s, m, priority, mem }) => {
  if (!m.tunnel_id) throw new ProvisionError("machine_not_ready", "machine has no tunnel to rotate");
  mem.token = await rotateTunnelSecret(ctx.cf, s.accountId, m.tunnel_id, randomTunnelSecret(), priority);
  return { patch: { tunnel_secret_generation: m.tunnel_secret_generation + 1 } };
};

const evict: StepFn = async ({ ctx, s, m, op, priority }) => {
  if (op.params.evict && m.tunnel_id) await deleteTunnelConnections(ctx.cf, s.accountId, m.tunnel_id, priority);
  return {};
};

export const ROTATE_STEPS: Record<RotateStep, StepFn> = { rotate_secret: rotateSecret, evict };
