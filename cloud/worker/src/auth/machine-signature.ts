/**
 * The signed machine API (D6): verifies a `/v1/machine/*` request with Phase 02's
 * `verifyMachineRequest`, supplying the key resolvers and the D1 nonce store, then applies
 * the Worker-side machine status rules.
 *
 * Check order is 02 §7's, cheap first, and nothing writes before the signature verifies:
 * headers, protocol, body size, path, clock window, key, signature, revocation, nonce.
 * Then the machine must be `active` (else `409 machine_not_ready`), and its last-seen and
 * reported protocol are stamped at most once a minute.
 *
 * - `registered` resolves the key from `machines` by `Yaran-Machine-Id`; revoked machines
 *   keep their key so they get `410 machine_revoked` (only after a valid signature).
 * - `pair_request` (W4 claim) resolves through `PairCodeKeyResolver`, which Phase 06
 *   supplies; until then every code is unknown (`400 pair_code_invalid`).
 *
 * <module-headers:begin>
 * Uses:
 * src/auth/machine-signature.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/auth/nonce-store.ts
 * ├── src/db/machines.ts
 * ├── src/http/context.ts
 * └── src/http/responses.ts
 * External: none
 *
 * Used by:
 * src/auth/machine-signature.ts
 * ├── src/auth/authorize.ts
 * ├── src/http/pipeline.ts
 * ├── src/pairing/pair-requests.ts
 * └── test/machine-signature.test.ts
 * <module-headers:end>
 */
import { PROTOCOL_MAX, PROTOCOL_MIN, verifyMachineRequest, type MachineKeyLookup } from "@yaran/protocol";
import { getMachine, MACHINE_SEEN_THROTTLE_S, touchMachineSeen, type MachineRow } from "../db/machines.ts";
import type { Identity, RequestContext } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import { d1NonceStore } from "./nonce-store.ts";

/** The 32-byte Ed25519 key recorded with a live pair code, or null (Phase 06). */
export type PairCodeKeyResolver = (db: D1Database, code: string, now: number) => Promise<Uint8Array | null>;

/** Placeholder until Phase 06 registers its resolver: no code is ever valid. */
export const noPairCodes: PairCodeKeyResolver = async () => null;

function claimCodeOf(body: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    const code = (parsed as { code?: unknown } | null)?.code;
    return typeof code === "string" && code.length > 0 && code.length <= 256 ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Verifies the machine signature on `ctx` and returns the machine identity. */
export async function verifyMachine(
  ctx: RequestContext, key: "registered" | "pair_request", pairCodeKey: PairCodeKeyResolver,
): Promise<Extract<Identity, { kind: "machine" }>> {
  const now = ctx.now();
  let row: MachineRow | null = null;
  const keys: MachineKeyLookup = {
    async byMachineId(id) {
      if (key !== "registered") return null;
      row = await getMachine(ctx.db, id);
      return row ? { publicKey: row.public_key, revoked: row.status === "revoking" || row.status === "revoked" } : null;
    },
    async byPairCode(code) {
      if (key !== "pair_request") return null;
      const publicKey = await pairCodeKey(ctx.db, code, now);
      return publicKey ? { publicKey, revoked: false } : null;
    },
  };
  const claimCode = key === "pair_request" ? claimCodeOf(ctx.body) : undefined;
  const result = await verifyMachineRequest({
    method: ctx.request.method,
    path: ctx.url.pathname + ctx.url.search,
    host: ctx.url.host,
    headers: ctx.request.headers,
    body: ctx.body,
    now,
    protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    ...(claimCode === undefined ? {} : { claimCode }),
    keys,
    nonces: d1NonceStore(ctx.db),
  });
  if (!result.ok) {
    const headers: Record<string, string> = result.code === "signature_expired" ? { Date: new Date(now * 1000).toUTCString() } : {};
    throw new HttpError(result.code, undefined, { ...(result.details ? { details: result.details } : {}), headers });
  }
  const machine = row as MachineRow | null;
  if (machine) {
    if (machine.status !== "active") {
      throw new HttpError("machine_not_ready", "This machine is not active yet; retry once provisioning has finished.");
    }
    const fresh = machine.last_seen_at !== null && machine.last_seen_at > now - MACHINE_SEEN_THROTTLE_S;
    if (!fresh || machine.reported_protocol !== result.protocol) await touchMachineSeen(ctx.db, machine.id, result.protocol, now);
  }
  return { kind: "machine", machineId: result.machineId, machine, protocol: result.protocol };
}
