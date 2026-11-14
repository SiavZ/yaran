/**
 * Test helpers for machine pairing: a fixture "machine" (Ed25519 key, PKCE verifier,
 * state) that drives W2 → W3 → W4 the way Phase 09's `yaran cloud login` will.
 *
 * - Signs the claim with @yaran/protocol's signing codec, the same canonical-string
 *   vectors Phase 09's Rust client is tested against.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/pair-helpers.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: none
 *
 * Used by:
 * test/pairing/pair-helpers.ts
 * ├── test/machine-api/claim.test.ts
 * ├── test/machine-api/machine-routes.test.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/pairing/authorize-params.test.ts
 * ├── test/pairing/authorize-route.test.ts
 * └── test/pairing/pair-requests.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, sha256, utf8 } from "@yaran/protocol";
import { CP_HOST, fakeJwt, makeWorld, seedUser, type SeededUser, type TestWorld } from "../phase06/fakes.ts";
import { CP_AUD, dispatch, machineKeys, signedRequest, type MachineKeys } from "../phase06/harness.ts";

export interface FixtureMachine {
  keys: MachineKeys;
  verifier: string;
  challenge: string;
  state: string;
  port: number;
  name: string;
}

export async function fixtureMachine(name = "laptop", port = 43123): Promise<FixtureMachine> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
  return {
    keys: await machineKeys(),
    verifier,
    challenge: b64urlEncode(await sha256(utf8.encode(verifier))),
    state: b64urlEncode(crypto.getRandomValues(new Uint8Array(24))),
    port,
    name,
  };
}

export function authorizeQuery(m: FixtureMachine, over: Record<string, string | null> = {}): URLSearchParams {
  const q: Record<string, string | null> = {
    v: "1",
    state: m.state,
    code_challenge: m.challenge,
    code_challenge_method: "S256",
    machine_pubkey: m.keys.publicB64,
    machine_name: m.name,
    callback: `http://127.0.0.1:${m.port}/callback`,
    yaran_version: "0.42.0",
    ...over,
  };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null) p.set(k, v);
  return p;
}

export function userJwt(email: string, claims: Record<string, unknown> = {}): string {
  return fakeJwt({ email, sub: `sub-${email}`, aud: [CP_AUD], exp: 1_800_086_400, type: "app", ...claims });
}

export interface PairWorld {
  w: TestWorld;
  user: SeededUser;
  jwt: string;
}

let n = 0;
/** A fresh world and user; D1 storage is shared within a test file, so emails are unique. */
export async function pairWorld(o: { role?: "user" | "admin" } = {}): Promise<PairWorld> {
  const w = await makeWorld();
  const user = await seedUser(w.ctx.db, `pairer${++n}-${crypto.randomUUID().slice(0, 6)}@example.org`, o);
  return { w, user, jwt: userJwt(user.email) };
}

export function getAuthorize(pw: PairWorld, query: URLSearchParams, jwt: string | null = pw.jwt): Promise<Response> {
  const headers: Record<string, string> = { Accept: "text/html" };
  if (jwt) headers["Cf-Access-Jwt-Assertion"] = jwt;
  return dispatch(new Request(`https://${CP_HOST}/v1/pair/authorize?${query}`, { headers }), pw.w);
}

export function postAuthorize(pw: PairWorld, form: Record<string, string>, origin: string | null = `https://${CP_HOST}`): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", "Cf-Access-Jwt-Assertion": pw.jwt };
  if (origin) headers["Origin"] = origin;
  return dispatch(new Request(`https://${CP_HOST}/v1/pair/authorize`, { method: "POST", headers, body: new URLSearchParams(form).toString() }), pw.w);
}

/** The hidden fields of the first form on a confirm page. */
export function formFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[m[1]!] ??= m[2]!;
  return out;
}

/** GET then approve; returns the callback Location's code and the machine id. */
export async function approvePairing(pw: PairWorld, m: FixtureMachine, extra: Record<string, string> = {}): Promise<{ code: string; machineId: string; location: string; requestId: string }> {
  const page = await getAuthorize(pw, authorizeQuery(m));
  if (page.status !== 200) throw new Error(`confirm page answered ${page.status}: ${page.headers.get("Location")}`);
  const f = formFields(await page.text());
  const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve", ...extra });
  const location = res.headers.get("Location") ?? "";
  const code = new URL(location).searchParams.get("code");
  if (res.status !== 302 || !code) throw new Error(`approve answered ${res.status} ${location}`);
  const row = await pw.w.ctx.db.prepare("SELECT machine_id FROM pair_requests WHERE id = ?").bind(f["request_id"]).first<{ machine_id: string }>();
  return { code, machineId: row!.machine_id, location, requestId: f["request_id"]! };
}

export async function claimRequest(pw: PairWorld, m: FixtureMachine, body: Record<string, unknown>, o: { now?: number; nonce?: string } = {}): Promise<Response> {
  const req = await signedRequest("POST", "/v1/machine/claim", { keys: m.keys, machineId: null, body, now: o.now ?? pw.w.clock.now, ...(o.nonce ? { nonce: o.nonce } : {}) });
  return dispatch(req, pw.w);
}

export function claimBody(m: FixtureMachine, code: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { code, code_verifier: m.verifier, yaran_version: "0.42.0", origin_port: 3890, ...over };
}

export async function machineCall(pw: PairWorld, m: FixtureMachine, machineId: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown, now?: number): Promise<Response> {
  const req = await signedRequest(method, path, { keys: m.keys, machineId, now: now ?? pw.w.clock.now, ...(body === undefined ? {} : { body }) });
  return dispatch(req, pw.w);
}

/** A machine paired end to end (authorize, approve, claim). */
export async function pairedMachine(pw: PairWorld, name = "laptop"): Promise<{ m: FixtureMachine; machineId: string }> {
  const m = await fixtureMachine(name);
  const { code, machineId } = await approvePairing(pw, m);
  const res = await claimRequest(pw, m, claimBody(m, code));
  if (res.status !== 200) throw new Error(`claim answered ${res.status}: ${await res.text()}`);
  return { m, machineId };
}
