/**
 * The signed machine API: Phase 02's signature fixtures through the Worker's resolvers and
 * D1 nonce store, then the Worker-side rules through the full pipeline.
 *
 * <module-headers:begin>
 * Uses:
 * test/machine-signature.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/sig/machine-request-negatives.json
 * ├── src/auth/machine-signature.ts
 * ├── src/db/client.ts
 * ├── src/db/machines.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * ├── src/log/logger.ts
 * ├── test/helpers/machine.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { b64urlDecode, b64urlEncode } from "@yaran/protocol";
import negatives from "@yaran/protocol/fixtures/sig/machine-request-negatives.json";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyMachine, type PairCodeKeyResolver } from "../src/auth/machine-signature.ts";
import { all, one } from "../src/db/client.ts";
import { getMachine } from "../src/db/machines.ts";
import { actorOf, type RequestContext } from "../src/http/context.ts";
import { HttpError } from "../src/http/responses.ts";
import { createLogger } from "../src/log/logger.ts";
import { machineKeys, signedRequest, type MachineKeys } from "./helpers/machine.ts";
import { closeSetup, NOW, seedMachine, seedUser } from "./helpers/seed.ts";
import { errorCode, handler, PROBE_ROUTES } from "./helpers/worker.ts";

let owner = "";
beforeAll(async () => {
  await closeSetup();
  owner = (await seedUser()).id;
});

describe("Phase 02 signature fixtures", () => {
  const pairKeys = new Map(negatives.pair_codes.map((p) => [p.code, b64urlDecode(p.public_key)!]));

  beforeAll(async () => {
    for (const m of negatives.machines) {
      await seedMachine({ owner, id: m.machine_id, publicKey: b64urlDecode(m.public_key)!, status: m.revoked ? "revoked" : "active" });
    }
  });

  negatives.cases.forEach((c, i) => {
    it(c.name, async () => {
      // Each case gets fresh nonces: shift the clock-independent nonce scope per case.
      await env.DB.prepare("DELETE FROM machine_nonces").run();
      for (const r of c.requests) {
        const request = new Request(`https://${r.host}${r.path}`, {
          method: r.method.toUpperCase(), headers: Object.entries(r.headers).filter((e): e is [string, string] => e[1] !== null), ...(r.body ? { body: r.body } : {}),
        });
        const ctx = {
          request, url: new URL(request.url), db: env.DB, body: new TextEncoder().encode(r.body), now: () => r.now,
          log: createLogger(), identity: { kind: "anonymous" },
        } as unknown as RequestContext;
        const key = r.path.startsWith("/v1/machine/claim") ? "pair_request" : "registered";
        // The Worker reads the code from the claim body; the fixture names the code it
        // means separately (claim_code), so the resolver looks that one up.
        const claimCode = (r as { claim_code?: string }).claim_code;
        const resolver: PairCodeKeyResolver = async () => (claimCode ? pairKeys.get(claimCode) ?? null : null);
        const outcome = await verifyMachine(ctx, key, resolver).then(() => ({ ok: true }), (e: HttpError) => ({ code: e.code }));
        expect(outcome, `${c.name} request ${i}`).toEqual(r.expect);
      }
    });
  });
});

describe("Worker rules through the pipeline", () => {
  let keys: MachineKeys;
  let active = "";
  const claimCode = "claim-code-0001";
  const call = handler({ pairCodeKey: async (_db, code) => (code === claimCode ? keys.publicKey : null) }, PROBE_ROUTES);
  beforeAll(async () => {
    keys = await machineKeys();
    active = await seedMachine({ owner, publicKey: keys.publicKey, status: "active" });
  });

  it("accepts a valid request and stamps last_seen_at and reported_protocol once a minute", async () => {
    const res = await call(await signedRequest({ keys, machineId: active, body: "{}" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ identity: "machine", machine: active, body: "{}" });
    expect(await getMachine(env.DB, active)).toMatchObject({ last_seen_at: NOW, reported_protocol: 1 });
  });

  it("accepts ±300 s of skew and refuses ±301 s with server_time and a Date header", async () => {
    for (const d of [300, -300]) expect((await call(await signedRequest({ keys, machineId: active, timestamp: NOW + d }))).status).toBe(200);
    for (const d of [301, -301]) {
      const res = await call(await signedRequest({ keys, machineId: active, timestamp: NOW + d }));
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; details: { server_time: string } } };
      expect(body.error.code).toBe("signature_expired");
      expect(body.error.details.server_time).toBe("2024-11-14T08:00:00Z");
      expect(res.headers.get("Date")).toBe(new Date(NOW * 1000).toUTCString());
    }
  });

  it("refuses malformed or missing headers with signature_missing (15- and 17-byte nonces included)", async () => {
    for (const bytes of [15, 17]) {
      const nonce = b64urlEncode(new Uint8Array(bytes));
      const req = await signedRequest({ keys, machineId: active });
      const headers = new Headers(req.headers);
      headers.set("Yaran-Nonce", nonce);
      expect(await errorCode(await call(new Request(req, { headers })))).toBe("signature_missing");
    }
    const req = await signedRequest({ keys, machineId: active });
    const headers = new Headers(req.headers);
    headers.delete("Yaran-Signature");
    expect(await errorCode(await call(new Request(req, { headers })))).toBe("signature_missing");
  });

  it("refuses a replayed nonce, and does not consume a nonce whose signature is bad", async () => {
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const good = await signedRequest({ keys, machineId: active, nonce, body: "{}" });
    const tampered = new Request(good.clone(), { body: '{"x":1}' });
    expect(await errorCode(await call(tampered))).toBe("signature_invalid");
    expect((await call(good.clone())).status).toBe(200);
    expect(await errorCode(await call(good))).toBe("nonce_replayed");
  });

  it("names an unknown machine machine_unknown and a bad signature signature_invalid, both 401", async () => {
    const unknown = await call(await signedRequest({ keys, machineId: crypto.randomUUID() }));
    expect([unknown.status, await errorCode(unknown)]).toEqual([401, "machine_unknown"]);
    const other = await machineKeys();
    const bad = await call(await signedRequest({ keys: other, machineId: active }));
    expect([bad.status, await errorCode(bad)]).toEqual([401, "signature_invalid"]);
  });

  it("reveals revocation only after a valid signature, and audits it once a minute", async () => {
    const revoked = await seedMachine({ owner, publicKey: keys.publicKey, status: "revoked" });
    const stranger = await machineKeys();
    expect(await errorCode(await call(await signedRequest({ keys: stranger, machineId: revoked })))).toBe("signature_invalid");
    for (let i = 0; i < 2; i++) {
      const res = await call(await signedRequest({ keys, machineId: revoked }));
      expect([res.status, await errorCode(res)]).toEqual([410, "machine_revoked"]);
    }
    const rows = await all<{ action: string; outcome: string; error_code: string; actor_kind: string }>(env.DB,
      "SELECT action, outcome, error_code, actor_kind FROM audit_log WHERE actor_id = ?", revoked);
    expect(rows).toEqual([{ action: "access.denied", outcome: "denied", error_code: "machine_revoked", actor_kind: "machine" }]);
  });

  it("answers 409 machine_not_ready for a machine that is not active", async () => {
    for (const status of ["provisioning", "awaiting_claim", "failed"] as const) {
      const id = await seedMachine({ owner, publicKey: keys.publicKey, status });
      expect(await errorCode(await call(await signedRequest({ keys, machineId: id })))).toBe("machine_not_ready");
    }
  });

  it("resolves W4 through the pair_request resolver and keys its nonce claim:<code>", async () => {
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const body = JSON.stringify({ code: claimCode });
    const res = await call(await signedRequest({ keys, machineId: null, path: "/v1/machine/claim", body, nonce }));
    expect(await res.json()).toMatchObject({ identity: "machine", machine: null });
    expect(await one(env.DB, "SELECT 1 AS x FROM machine_nonces WHERE machine_id = ? AND nonce = ?", `claim:${claimCode}`, nonce)).toEqual({ x: 1 });
    const unknown = await call(await signedRequest({ keys, machineId: null, path: "/v1/machine/claim", body: '{"code":"nope"}' }));
    expect(await errorCode(unknown)).toBe("pair_code_invalid");
    expect(await errorCode(await handler()(await signedRequest({ keys, machineId: null, path: "/v1/machine/claim", body })))).toBe("pair_code_invalid");
  });

  it("maps a machine identity to a machine actor", () => {
    expect(actorOf({ kind: "machine", machineId: active, machine: null, protocol: 1 })).toEqual({ kind: "machine", id: active });
  });
});
