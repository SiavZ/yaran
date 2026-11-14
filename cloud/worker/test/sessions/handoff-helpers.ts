/**
 * Test helpers for the control-plane handoff: a phone with its ephemeral ECDH key and
 * its long-lived device key, the signed W16 query it sends, and the consent POST.
 *
 * - The device signature is built with @yaran/protocol's canonical string, exactly as
 *   the app (Phase 14/15) signs it.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/handoff-helpers.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/sessions/handoff-route.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: none
 *
 * Used by:
 * test/sessions/handoff-helpers.ts
 * ├── test/pairing/audit-coverage.test.ts
 * ├── test/sessions/handoff-remembered.test.ts
 * └── test/sessions/handoff-route.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, handoffDeviceCanonical, utf8 } from "@yaran/protocol";
import { HANDOFF_ROUTES } from "../../src/sessions/handoff-route.ts";
import { APP_CALLBACK, CP_HOST, fakeJwt, makeWorld, seedUser, type SeededUser, type TestWorld } from "../phase06/fakes.ts";
import { CP_AUD, dispatch } from "../phase06/harness.ts";

export interface Phone {
  ecdh: CryptoKeyPair;
  pk: string;
  device: CryptoKeyPair;
  dk: string;
}

const raw = async (k: CryptoKey) => b64urlEncode(new Uint8Array((await crypto.subtle.exportKey("raw", k)) as ArrayBuffer));

export async function makePhone(device?: CryptoKeyPair): Promise<Phone> {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const dev = device ?? ((await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair);
  return { ecdh, pk: await raw(ecdh.publicKey), device: dev, dk: await raw(dev.publicKey) };
}

export async function signDevice(key: CryptoKey, host: string, pk: string, state: string, dts: string): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(handoffDeviceCanonical({ host, pk, state, dts })));
  return b64urlEncode(new Uint8Array(sig as ArrayBuffer));
}

export const STATE = "c3RhdGUtZm9yLXRoZS1oYW5kb2ZmLXRlc3Q";

export interface Setup {
  w: TestWorld;
  user: SeededUser;
  jwt: string;
  phone: Phone;
}

let seq = 0;

export async function setup(): Promise<Setup> {
  const w = await makeWorld();
  // Storage is shared within a test file, so every setup gets its own user.
  const user = await seedUser(w.ctx.db, `ada${++seq}@example.org`);
  const jwt = fakeJwt({ email: user.email, sub: "sub-ada", exp: w.clock.now + 3600, aud: [CP_AUD], type: "app" });
  return { w, user, jwt, phone: await makePhone() };
}

/** The W16 query a phone sends, signed now unless overridden. */
export async function handoffQuery(s: Setup, o: Record<string, string | null> = {}, signer?: CryptoKey): Promise<URLSearchParams> {
  const dts = o["dts"] ?? String(s.w.clock.now);
  const state = o["state"] ?? STATE;
  const pk = o["pk"] ?? s.phone.pk;
  const q: Record<string, string | null> = {
    v: "1",
    pk,
    state,
    redirect: APP_CALLBACK,
    device: "Ada's Pixel",
    dk: s.phone.dk,
    dts,
    dsig: await signDevice(signer ?? s.phone.device.privateKey, CP_HOST, pk, state, dts),
    ...o,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== null) params.set(k, v);
  return params;
}

export function get(s: Setup, params: URLSearchParams, headers: Record<string, string> = {}): Promise<Response> {
  return dispatch(HANDOFF_ROUTES, new Request(`https://${CP_HOST}/v1/handoff?${params}`, { headers: { "Cf-Access-Jwt-Assertion": s.jwt, ...headers } }), s.w.ctx);
}

export function post(s: Setup, form: URLSearchParams, headers: Record<string, string> = {}): Promise<Response> {
  return dispatch(
    HANDOFF_ROUTES,
    new Request(`https://${CP_HOST}/v1/handoff`, {
      method: "POST",
      body: form.toString(),
      headers: { "Cf-Access-Jwt-Assertion": s.jwt, "Content-Type": "application/x-www-form-urlencoded", Origin: `https://${CP_HOST}`, ...headers },
    }),
    s.w.ctx,
  );
}

/** The hidden fields of the consent page's form, with the chosen decision. */
export async function formFromPage(res: Response, decision: "continue" | "cancel"): Promise<URLSearchParams> {
  const html = await res.text();
  const form = new URLSearchParams();
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) form.set(m[1]!, m[2]!.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  form.set("decision", decision);
  return form;
}

/** The callback parameters of a redirect (query or fragment). */
export function callbackParams(res: Response): URLSearchParams {
  const loc = res.headers.get("Location")!;
  const i = loc.search(/[?#]/);
  return new URLSearchParams(loc.slice(i + 1));
}
