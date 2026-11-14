/**
 * W4 `POST /v1/machine/claim`: the machine half of pairing. Exchanges a one-time code
 * (plus its PKCE verifier) for the machine's identity and tunnel credentials, 02's
 * `ClaimResponse`.
 *
 * - 04's pipeline has already verified the Ed25519 signature against the key the code's
 *   pair request recorded (resolver `pairCodeKey`) and consumed the nonce `claim:<code>`.
 * - Exactly one claim of a code wins: the `confirmed → claimed` transition is conditional.
 * - A Replace pairing tears the old machine down only after this claim has succeeded.
 * - The answer carries a secret (the tunnel token): `Cache-Control: no-store`.
 *
 * <module-headers:begin>
 * Uses:
 * src/machine-api/claim.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/machines/machine-rows.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/pairing/pkce.ts
 * ├── src/seams/context.ts
 * ├── src/seams/foundation.ts
 * └── src/shared/json-body.ts
 * External: none
 *
 * Used by:
 * src/machine-api/claim.ts
 * └── src/routes/pairing-and-sessions.ts
 * <module-headers:end>
 */
import type { ClaimRequest, ClaimResponse } from "@yaran/protocol";
import { activateClaimed, getMachine, markReplaced } from "../machines/machine-rows.ts";
import { claim, findByCode } from "../pairing/pair-requests.ts";
import { verifyS256 } from "../pairing/pkce.ts";
import type { RouteCall, RouteRow } from "../seams/context.ts";
import { ApiError } from "../seams/foundation.ts";
import { checkOriginPortField, parseJson, validated } from "../shared/json-body.ts";

const codeInvalid = () => new ApiError("pair_code_invalid", "This pairing code is unknown, used or expired. Run the login command again.");

async function postClaim({ ctx, body, machine }: RouteCall): Promise<Response> {
  const raw = parseJson(body);
  checkOriginPortField(raw);
  const req = validated<ClaimRequest>("ClaimRequest", raw);
  const pair = await findByCode(ctx, req.code);
  if (!pair || pair.machine_id === null) throw codeInvalid();
  if (!(await verifyS256(req.code_verifier, pair.code_challenge))) {
    throw new ApiError("pkce_mismatch", "The code verifier does not match the challenge sent when pairing started.");
  }
  const m = await getMachine(ctx, pair.machine_id);
  if (!m || m.status !== "awaiting_claim" || m.hostname === null || m.tunnel_id === null) throw codeInvalid();

  const tunnel = await ctx.provisioning.fetchTunnelToken(m.id);
  if (req.origin_port !== pair.origin_port) await ctx.provisioning.setOriginPort(m.id, req.origin_port);
  if (!(await claim(ctx, pair.id, req.code))) throw codeInvalid();
  const protocol = machine?.protocol ?? 1;
  if (!(await activateClaimed(ctx, m.id, { yaranVersion: req.yaran_version, originPort: req.origin_port, protocol }))) throw codeInvalid();
  await ctx.audit.record({ action: "machine.claimed", actor: { kind: "machine", id: m.id }, target: { kind: "machine", id: m.id }, outcome: "ok", detail: { machine_name: m.name, yaran_version: req.yaran_version } });

  if (pair.replaces_machine_id !== null) {
    const old = await getMachine(ctx, pair.replaces_machine_id);
    if (old && old.status === "active") {
      await markReplaced(ctx, old.id, m.id);
      await ctx.provisioning.startTeardown(old.id, "user_unpair");
      await ctx.audit.record({ action: "machine.replaced", actor: { kind: "machine", id: m.id }, target: { kind: "machine", id: old.id }, outcome: "ok", detail: { replaced_by: m.id } });
    }
  }

  const [settings, internal, owner] = await Promise.all([
    ctx.settings.read(),
    ctx.settings.internal(),
    ctx.db.prepare("SELECT email, slug FROM users WHERE id = ?").bind(m.owner_user_id).first<{ email: string; slug: string }>(),
  ]);
  const answer: ClaimResponse = {
    machine_id: m.id,
    machine_name: m.name,
    hostname: m.hostname,
    url: `https://${m.hostname}`,
    origin_port: req.origin_port,
    tunnel,
    access: { team_domain: internal.teamDomain!, aud: m.access_app_aud! },
    owner_email: owner!.email,
    user_slug: owner!.slug,
    org: { name: settings.org_name, url: `https://${internal.controlPlaneHost}` },
    protocol,
  };
  return Response.json(answer, { headers: { "Cache-Control": "no-store", "Yaran-Machine-Id": m.id } });
}

export const CLAIM_ROUTE: RouteRow = {
  method: "POST",
  path: "/v1/machine/claim",
  auth: { kind: "machine", key: "pair_request" },
  kind: "json",
  handler: postClaim,
  rateLimit: "RL_AUTH",
  bodyLimit: 65536,
};
