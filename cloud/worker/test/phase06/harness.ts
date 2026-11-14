/**
 * A fake of Phase 04's request pipeline, just deep enough to drive Phase 06's route rows
 * end to end: route match, the Origin rule, `requireUser`, the machine-signature check
 * (through @yaran/protocol's verifier and a D1 nonce table), the install-id check and
 * `ApiError` mapping.
 *
 * - `requireUser` decodes the `Cf-Access-Jwt-Assertion` payload without verifying it
 *   (04 owns verification); it refuses a missing JWT, a service token, another AUD and a
 *   disabled or unknown user with 04's codes.
 *
 * <module-headers:begin>
 * Uses:
 * test/phase06/harness.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/devices/install-id.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/seams/context.ts
 * ├── src/seams/foundation.ts
 * └── test/phase06/fakes.ts
 * External: none
 *
 * Used by:
 * test/phase06/harness.ts
 * ├── test/devices/devices-route.test.ts
 * ├── test/me/machines-route.test.ts
 * ├── test/me/me-route.test.ts
 * ├── test/me/meta.test.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/pairing/pair-helpers.ts
 * └── test/sessions/handoff-helpers.ts
 * <module-headers:end>
 */
import {
  b64urlDecode,
  b64urlEncode,
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  signMachineRequest,
  utf8,
  utf8Decode,
  verifyMachineRequest,
  type ErrorCode,
} from "@yaran/protocol";
import { checkInstallId } from "../../src/devices/install-id.ts";
import { pairCodeKey } from "../../src/pairing/pair-requests.ts";
import type { Phase06Ctx, RouteRow } from "../../src/seams/context.ts";
import { ApiError, errorResponse, type UserIdentity } from "../../src/seams/foundation.ts";
import { CP_HOST } from "./fakes.ts";

export const CP_AUD = "cp-aud";

async function requireUser(req: Request, ctx: Phase06Ctx): Promise<UserIdentity> {
  const jwt = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) throw new ApiError("unauthenticated", "No Access JWT.");
  const payload = JSON.parse(utf8Decode(b64urlDecode(jwt.split(".")[1] ?? "")!) ?? "{}") as Record<string, unknown>;
  if (payload["common_name"] !== undefined || !payload["email"]) throw new ApiError("service_token_rejected", "Service tokens cannot use this route.");
  const aud = payload["aud"];
  if (!(Array.isArray(aud) ? aud : [aud]).includes(CP_AUD)) throw new ApiError("unauthenticated", "JWT for another application.");
  const email = String(payload["email"]).toLowerCase();
  const row = await ctx.db.prepare("SELECT id, role, status, slug FROM users WHERE email = ?").bind(email).first<{ id: string; role: "user" | "admin"; status: string; slug: string }>();
  if (!row) throw new ApiError("unauthenticated", "Unknown user.");
  if (row.status === "disabled") throw new ApiError("user_disabled", "This account is disabled.");
  return { userId: row.id, email, sub: String(payload["sub"]), exp: Number(payload["exp"]), role: row.role, slug: row.slug };
}

function match(rows: readonly RouteRow[], req: Request): { row: RouteRow; params: Record<string, string> } | null {
  for (const row of rows) {
    if (row.method !== req.method) continue;
    const m = new URLPattern({ pathname: row.path }).exec(req.url);
    if (m) return { row, params: m.pathname.groups as Record<string, string> };
  }
  return null;
}

/** Runs one request through the fake pipeline. */
export async function dispatch(rows: readonly RouteRow[], req: Request, ctx: Phase06Ctx): Promise<Response> {
  const hit = match(rows, req);
  if (!hit) return errorResponse("not_found", "No such route.", ctx.requestId);
  const { row, params } = hit;
  const body = new Uint8Array(await req.arrayBuffer());
  try {
    const origin = req.headers.get("Origin");
    const mutating = req.method !== "GET";
    if (mutating && row.auth.kind === "user" && origin !== null && origin !== `https://${CP_HOST}` && row.kind === "json") {
      throw new ApiError("origin_mismatch", "Cross-origin request refused.");
    }
    let user: UserIdentity | null = null;
    let machine: { id: string | null; protocol: number } | null = null;
    switch (row.auth.kind) {
      case "user":
      case "admin":
        user = await requireUser(req, ctx);
        await checkInstallId(ctx, user, req.headers.get("Yaran-Install-Id"));
        break;
      case "machine": {
        const path = new URL(req.url).pathname;
        const claimCode = row.auth.key === "pair_request" ? (JSON.parse(utf8Decode(body) || "{}") as { code?: string }).code : undefined;
        const v = await verifyMachineRequest({
          method: req.method,
          path,
          host: new URL(req.url).host,
          headers: req.headers,
          body,
          now: ctx.now(),
          protocol: { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
          ...(claimCode ? { claimCode } : {}),
          keys: {
            byMachineId: async (id) => {
              const r = await ctx.db.prepare("SELECT public_key, status FROM machines WHERE id = ?").bind(id).first<{ public_key: ArrayBuffer; status: string }>();
              return r ? { publicKey: new Uint8Array(r.public_key), revoked: r.status === "revoking" || r.status === "revoked" } : null;
            },
            byPairCode: (code) => pairCodeKey(ctx, code),
          },
          nonces: {
            recordIfNew: async (scope, nonce, exp) =>
              (await ctx.db.prepare("INSERT OR IGNORE INTO machine_nonces (machine_id, nonce, expires_at) VALUES (?, ?, ?)").bind(scope, nonce, exp).run()).meta.changes === 1,
          },
        });
        if (!v.ok) throw new ApiError(v.code as ErrorCode, `Machine signature refused: ${v.code}.`, v.details);
        machine = { id: v.machineId, protocol: v.protocol };
        break;
      }
      case "public":
      case "setup":
        break;
    }
    return await row.handler({ req, ctx, params, user, machine, body });
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e.code, e.message, ctx.requestId, e.details);
    throw e;
  }
}

export interface MachineKeys {
  privateKey: CryptoKey;
  publicKey: Uint8Array;
  publicB64: string;
}

export async function machineKeys(): Promise<MachineKeys> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  return { privateKey: kp.privateKey, publicKey, publicB64: b64urlEncode(publicKey) };
}

/** A signed machine request, as yaran's client (Phase 09) sends it. */
export async function signedRequest(
  method: "GET" | "POST" | "PUT",
  path: string,
  o: { keys: MachineKeys; machineId: string | null; body?: unknown; now: number; nonce?: string },
): Promise<Request> {
  const bytes = o.body === undefined ? new Uint8Array() : utf8.encode(JSON.stringify(o.body));
  const headers = await signMachineRequest({
    method,
    path,
    host: CP_HOST,
    protocol: "1",
    machineId: o.machineId,
    body: bytes,
    privateKey: o.keys.privateKey,
    timestamp: String(o.now),
    ...(o.nonce ? { nonce: o.nonce } : {}),
  });
  if (bytes.length) headers["Content-Type"] = "application/json";
  return new Request(`https://${CP_HOST}${path}`, { method, headers, ...(bytes.length ? { body: bytes } : {}) });
}
