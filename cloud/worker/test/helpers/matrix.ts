/**
 * The authorization-matrix corpus: every identity kind the Worker must tell apart, a
 * request builder for any route row, and the outcome each route's declared `auth` class
 * implies. `authz-matrix.test.ts` asserts the outcomes; `no-secret-leak.test.ts` replays
 * the same requests looking for secrets.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/matrix.ts
 * ├── src/http/routes.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/machine.ts
 * ├── test/helpers/seed.ts
 * ├── test/helpers/worker.ts
 * └── test/setup.ts
 * External: cloudflare:test, msw
 *
 * Used by:
 * test/helpers/matrix.ts
 * ├── test/authz-matrix.test.ts
 * └── test/no-secret-leak.test.ts
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { http, HttpResponse } from "msw";
import { network } from "../setup.ts";
import type { Route } from "../../src/http/routes.ts";
import { mintJwt, mintServiceToken, serveJwks } from "./access.ts";
import { machineKeys, signedRequest, type MachineKeys } from "./machine.ts";
import { closeSetup, CP_HOST, NOW, openSetup, seedMachine, seedUser } from "./seed.ts";
import { handler } from "./worker.ts";

export const IDENTITIES = [
  "none", "user", "admin", "disabled", "service_token", "other_aud",
  "machine", "revoked_machine", "unknown_machine", "replayed_nonce", "skewed_clock",
] as const;
export type IdentityKind = (typeof IDENTITIES)[number];
export const HOSTS = { control_plane: CP_HOST, workers_dev: "yaran-cloud.acme.workers.dev" } as const;
export type HostKind = keyof typeof HOSTS;
export type SetupKind = "open" | "closed";

export const CLAIM_CODE = "matrix-claim-code";

/** `ok` means the route ran (no auth refusal); otherwise the registry code expected. */
export type Expected = "ok" | string;

function assertNever(value: never): never {
  throw new Error(`no matrix expectation for ${JSON.stringify(value)}`);
}

const JWT_REFUSAL: Record<IdentityKind, Expected> = {
  none: "unauthenticated", user: "ok", admin: "ok", disabled: "user_disabled", service_token: "service_token_rejected",
  other_aud: "unauthenticated", machine: "unauthenticated", revoked_machine: "unauthenticated", unknown_machine: "unauthenticated",
  replayed_nonce: "unauthenticated", skewed_clock: "unauthenticated",
};

/** The outcome a route's declared auth class implies for one identity, host and setup state. */
export function expected(route: Route, id: IdentityKind, host: HostKind, setup: SetupKind): Expected {
  const auth = route.auth;
  if (setup === "open") {
    // The wizard is served on workers.dev only; the admin claim arrives on the control plane.
    if (auth.kind === "public") return "ok";
    if (auth.kind === "setup") return host === "workers_dev" || route.path === "/setup/claim" ? "ok" : "setup_incomplete";
    return "setup_incomplete";
  }
  if (host !== "control_plane") return "misdirected_host";
  switch (auth.kind) {
    case "public":
      return "ok";
    case "setup":
      return "setup_closed";
    case "user":
      return JWT_REFUSAL[id];
    case "admin":
      return id === "user" ? "forbidden" : JWT_REFUSAL[id];
    case "machine": {
      const claim = auth.key === "pair_request";
      switch (id) {
        case "machine": return "ok";
        case "revoked_machine": return claim ? "signature_missing" : "machine_revoked";
        case "unknown_machine": return claim ? "signature_missing" : "machine_unknown";
        case "replayed_nonce": return "nonce_replayed";
        case "skewed_clock": return "signature_expired";
        default: return "signature_missing";
      }
    }
    default:
      return assertNever(auth);
  }
}

export interface Fixture {
  keys: MachineKeys;
  active: string;
  revoked: string;
  jwts: Record<"user" | "admin" | "disabled" | "service_token" | "other_aud", string>;
  call: ReturnType<typeof handler>;
  /** Every Yaran-Signature value the corpus has sent. */
  signatures: string[];
}

export async function matrixFixture(): Promise<Fixture> {
  await closeSetup();
  const keys = await machineKeys();
  const owner = await seedUser();
  const admin = await seedUser({ role: "admin" });
  const disabled = await seedUser({ disabled: true });
  const active = await seedMachine({ owner: owner.id, publicKey: keys.publicKey, status: "active" });
  // A provisioned machine, so routes that need its tunnel and Access app answer.
  await env.DB.prepare("UPDATE machines SET tunnel_id = ?, access_app_id = ?, access_app_aud = ? WHERE id = ?")
    .bind(crypto.randomUUID(), crypto.randomUUID(), "a".repeat(64), active).run();
  return {
    keys,
    active,
    revoked: await seedMachine({ owner: owner.id, publicKey: keys.publicKey, status: "revoked" }),
    jwts: {
      user: await mintJwt({ email: owner.email }),
      admin: await mintJwt({ email: admin.email }),
      disabled: await mintJwt({ email: disabled.email }),
      service_token: await mintServiceToken(),
      other_aud: await mintJwt({ email: owner.email, aud: "f".repeat(64) }),
    },
    call: handler({ pairCodeKey: async (_db, code) => (code === CLAIM_CODE ? keys.publicKey : null) }),
    signatures: [],
  };
}

/** Undoes what a route that ran did to the fixture machine (an unpair revokes it). */
export async function resetActive(f: Fixture): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provisioning_ops WHERE machine_id = ?").bind(f.active),
    env.DB.prepare("UPDATE machines SET status = 'active', revoke_reason = NULL, revoked_by = NULL, revoked_at = NULL WHERE id = ?").bind(f.active),
  ]);
}

export async function setSetupState(setup: SetupKind): Promise<void> {
  if (setup === "open") await openSetup();
  else await closeSetup();
}

let ipCounter = 0;

/** Sends one matrix request (a replay sends it twice and returns the second answer). */
export async function send(f: Fixture, route: Route, id: IdentityKind, host: HostKind, environment: Cloudflare.Env = env): Promise<Response> {
  serveJwks();
  // A route that reaches Cloudflare (an unpair's teardown) finds nothing there, which is done.
  network.use(http.all("https://api.cloudflare.com/*", () =>
    HttpResponse.json({ success: false, errors: [{ code: 7003, message: "not found" }], messages: [], result: null }, { status: 404 })));
  const hostname = HOSTS[host];
  const path = route.path.replace(/:[a-z_]+/g, () => crypto.randomUUID());
  const query = route.protocol === "query" ? "?v=1" : "";
  const isClaim = route.auth.kind === "machine" && route.auth.key === "pair_request";
  const hasBody = route.method !== "GET" && route.method !== "DELETE";
  const body = isClaim ? JSON.stringify({ code: CLAIM_CODE }) : hasBody ? "{}" : "";
  const ip = `198.18.${(ipCounter >> 8) & 255}.${ipCounter++ & 255}`;
  let request: Request;
  if (["machine", "revoked_machine", "unknown_machine", "replayed_nonce", "skewed_clock"].includes(id)) {
    const machineId = id === "revoked_machine" ? f.revoked : id === "unknown_machine" ? crypto.randomUUID() : isClaim ? null : f.active;
    // Off the machine API the headers are still a well-formed signature (over a machine path).
    const signed = await signedRequest({
      keys: f.keys, machineId, path: route.auth.kind === "machine" ? path : "/v1/machine/probe", method: route.method, body,
      host: hostname, timestamp: id === "skewed_clock" ? NOW + 301 : NOW,
    });
    f.signatures.push(signed.headers.get("Yaran-Signature")!);
    request = new Request(`https://${hostname}${path}${query}`, { method: route.method, headers: signed.headers, ...(route.method === "GET" ? {} : { body }) });
  } else {
    const headers: Record<string, string> = { "Yaran-Protocol": "1", "Content-Type": "application/json" };
    if (id !== "none") headers["Cf-Access-Jwt-Assertion"] = f.jwts[id as keyof Fixture["jwts"]];
    request = new Request(`https://${hostname}${path}${query}`, { method: route.method, headers, ...(hasBody ? { body } : {}) });
  }
  const withIp = (r: Request) => {
    const h = new Headers(r.headers);
    h.set("CF-Connecting-IP", ip);
    return new Request(r, { headers: h });
  };
  if (id === "replayed_nonce") {
    await f.call(withIp(request.clone()), environment);
    // The first send may have unpaired the machine; the replay must meet the nonce check.
    await resetActive(f);
  }
  return f.call(withIp(request), environment);
}
