/**
 * Drives Phase 06's routes through 04's real request pipeline at a test world's clock.
 *
 * - An unsigned `fakeJwt` in `Cf-Access-Jwt-Assertion` is re-signed with the test JWKS key
 *   (claims unchanged, issuer defaulted), so Access verification runs for real. A test that
 *   compares the token the Worker saw signs it up front with `signed`.
 * - A JSON request without `Yaran-Protocol` gets version 1, and each request a fresh
 *   client IP: these tests are about Phase 06, not 04's negotiation or per-IP buckets.
 * - The world's `settings` are flushed to D1 before, and its `audit` reloaded after.
 *
 * <module-headers:begin>
 * Uses:
 * test/phase06/harness.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/pairing/pair-requests.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * ├── test/helpers/worker.ts
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
import { b64urlDecode, b64urlEncode, signMachineRequest, utf8, utf8Decode } from "@yaran/protocol";
import { pairCodeKey } from "../../src/pairing/pair-requests.ts";
import { mintJwt } from "../helpers/access.ts";
import { TEAM } from "../helpers/seed.ts";
import { handler } from "../helpers/worker.ts";
import { CP_HOST, type TestWorld } from "./fakes.ts";

export { CP_AUD } from "./fakes.ts";

let ipSeq = 0;

/** The same claims signed with the test JWKS key; a token already signed passes unchanged. */
export async function signed(token: string): Promise<string> {
  if (!token.endsWith(".c2ln")) return token;
  const claims = JSON.parse(utf8Decode(b64urlDecode(token.split(".")[1] ?? "") ?? new Uint8Array()) ?? "{}") as Record<string, unknown>;
  const { email, sub, aud, iss, exp, nbf, iat: _iat, ...extra } = claims;
  return mintJwt({
    email: typeof email === "string" ? email : null,
    sub: typeof sub === "string" ? sub : "",
    aud: (Array.isArray(aud) ? aud[0] : aud) as string,
    iss: typeof iss === "string" ? iss : `https://${TEAM}`,
    ...(typeof exp === "number" ? { exp } : {}),
    ...(typeof nbf === "number" ? { nbf } : {}),
    extra,
  });
}

/** Runs one request through the production route table and pipeline. */
export async function dispatch(req: Request, w: TestWorld): Promise<Response> {
  await w.flush();
  const headers = new Headers(req.headers);
  const jwt = headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", await signed(jwt));
  if (!headers.has("Yaran-Protocol")) headers.set("Yaran-Protocol", "1");
  headers.set("CF-Connecting-IP", `198.51.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await handler({ now: () => w.clock.now, pairCodeKey })(new Request(req.url, { method: req.method, headers, ...(body ? { body } : {}), redirect: "manual" }), w.env);
  await w.refresh();
  return res;
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
