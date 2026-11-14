/**
 * W4 claim: the authorize → claim round trip with a fixture machine signing through
 * @yaran/protocol, every refusal code, racing claims, origin-port reconciliation and
 * the Replace flow's teardown order.
 *
 * <module-headers:begin>
 * Uses:
 * test/machine-api/claim.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/pairing/pair-helpers.ts
 * └── test/phase06/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { b64urlEncode, validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { fakeAud, seedMachine } from "../phase06/fakes.ts";
import { approvePairing, claimBody, claimRequest, fixtureMachine, pairWorld } from "../pairing/pair-helpers.ts";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe("POST /v1/machine/claim", () => {
  it("round trip: answers a schema-valid ClaimResponse, no-store, and activates the machine", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c, machineId } = await approvePairing(pw, m);
    const res = await claimRequest(pw, m, claimBody(m, c));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Yaran-Machine-Id")).toBe(machineId);
    const body = (await res.json()) as Record<string, unknown>;
    expect(validate("ClaimResponse", body)).toEqual({ valid: true, errors: [] });
    expect(body).toMatchObject({
      machine_id: machineId,
      machine_name: "laptop",
      origin_port: 3890,
      owner_email: pw.user.email,
      user_slug: pw.user.slug,
      access: { team_domain: "acme.cloudflareaccess.com", aud: fakeAud(machineId) },
      org: { name: "Example Org", url: "https://cp.example.com" },
      protocol: 1,
    });
    const row = await pw.w.ctx.db.prepare("SELECT status, yaran_version, claimed_at FROM machines WHERE id = ?").bind(machineId).first();
    expect(row).toMatchObject({ status: "active", yaran_version: "0.42.0", claimed_at: pw.w.clock.now });
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "machine.claimed", actor: { kind: "machine", id: machineId } });
  });

  it("the code is single use: a second claim is pair_code_invalid", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c } = await approvePairing(pw, m);
    expect((await claimRequest(pw, m, claimBody(m, c))).status).toBe(200);
    const again = await claimRequest(pw, m, claimBody(m, c));
    expect(again.status).toBe(400);
    expect(await code(again)).toBe("pair_code_invalid");
  });

  it("two concurrent claims of one code yield exactly one success", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c } = await approvePairing(pw, m);
    const results = await Promise.all([claimRequest(pw, m, claimBody(m, c)), claimRequest(pw, m, claimBody(m, c)), claimRequest(pw, m, claimBody(m, c))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it("a code older than 120 s is pair_code_invalid", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c } = await approvePairing(pw, m);
    pw.w.clock.now += 121;
    const res = await claimRequest(pw, m, claimBody(m, c));
    expect(await code(res)).toBe("pair_code_invalid");
  });

  it.each([
    ["wrong verifier", "pkce_mismatch", 400],
    ["wrong key", "signature_invalid", 401],
    ["skewed clock", "signature_expired", 401],
    ["replayed nonce", "nonce_replayed", 401],
    ["origin port 0", "origin_port_invalid", 400],
  ])("%s → %s", async (kind, expected, status) => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c } = await approvePairing(pw, m);
    let res: Response;
    switch (kind) {
      case "wrong verifier":
        res = await claimRequest(pw, m, claimBody(m, c, { code_verifier: b64urlEncode(new Uint8Array(32)) }));
        break;
      case "wrong key":
        res = await claimRequest(pw, { ...m, keys: (await fixtureMachine()).keys }, claimBody(m, c));
        break;
      case "skewed clock":
        res = await claimRequest(pw, m, claimBody(m, c), { now: pw.w.clock.now - 301 });
        break;
      case "replayed nonce": {
        const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
        expect((await claimRequest(pw, m, claimBody(m, c, { code_verifier: "x".repeat(43) }), { nonce })).status).toBe(400);
        res = await claimRequest(pw, m, claimBody(m, c, { code_verifier: "x".repeat(43) }), { nonce });
        break;
      }
      default:
        res = await claimRequest(pw, m, claimBody(m, c, { origin_port: 0 }));
    }
    expect(res.status).toBe(status);
    expect(await code(res)).toBe(expected);
  });

  it("a claim whose origin_port differs from authorize calls setOriginPort before answering", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c, machineId } = await approvePairing(pw, m);
    const res = await claimRequest(pw, m, claimBody(m, c, { origin_port: 4000 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { origin_port: number }).origin_port).toBe(4000);
    expect(pw.w.prov.calls.find((x) => x.fn === "setOriginPort")?.args).toEqual([machineId, 4000]);
  });

  it("the same origin_port makes no setOriginPort call", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { code: c } = await approvePairing(pw, m);
    await claimRequest(pw, m, claimBody(m, c));
    expect(pw.w.prov.calls.some((x) => x.fn === "setOriginPort")).toBe(false);
  });

  it("Replace tears the old machine down only after the claim succeeds", async () => {
    const pw = await pairWorld();
    const old = await seedMachine(pw.w.ctx.db, pw.user, { name: "laptop" });
    const m = await fixtureMachine();
    const { code: c, machineId } = await approvePairing(pw, m, { replace_machine_id: old });
    expect(pw.w.prov.calls.some((x) => x.fn === "startTeardown")).toBe(false);
    // A failed claim leaves the old machine alone.
    await claimRequest(pw, m, claimBody(m, c, { code_verifier: b64urlEncode(new Uint8Array(32)) }));
    expect(pw.w.prov.calls.some((x) => x.fn === "startTeardown")).toBe(false);
    expect((await claimRequest(pw, m, claimBody(m, c))).status).toBe(200);
    const fns = pw.w.prov.calls.map((x) => x.fn);
    expect(fns.indexOf("startTeardown")).toBeGreaterThan(fns.lastIndexOf("fetchTunnelToken"));
    expect(pw.w.prov.calls.find((x) => x.fn === "startTeardown")?.args).toEqual([old, "user_unpair"]);
    const oldRow = await pw.w.ctx.db.prepare("SELECT status, replaced_by FROM machines WHERE id = ?").bind(old).first();
    expect(oldRow).toMatchObject({ status: "revoking", replaced_by: machineId });
    expect(pw.w.audit.map((a) => a.action).slice(-2)).toEqual(["machine.claimed", "machine.replaced"]);
  });
});
