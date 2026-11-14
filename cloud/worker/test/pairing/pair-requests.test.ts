/**
 * The pair-request repository's guarded transitions and the sweep: lifetimes under an
 * injected clock, only hashes stored, and the sweep's teardown, csrf purge and audit.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/pair-requests.test.ts
 * ├── src/pairing/pair-requests.ts
 * ├── src/pairing/pkce.ts
 * ├── src/pairing/sweep.ts
 * └── test/pairing/pair-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { approve, claim, createPending, deny, expire, findByCode } from "../../src/pairing/pair-requests.ts";
import { runPairSweep } from "../../src/pairing/sweep.ts";
import { randomToken } from "../../src/pairing/pkce.ts";
import { approvePairing, authorizeQuery, fixtureMachine, getAuthorize, pairWorld } from "./pair-helpers.ts";

async function pending(pw: Awaited<ReturnType<typeof pairWorld>>): Promise<string> {
  return createPending(pw.w.ctx, {
    userId: pw.user.id,
    state: "s".repeat(32),
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    machinePublicKey: new Uint8Array(32),
    machineName: "laptop",
    callbackPort: 40000,
    originPort: 3890,
    yaranVersion: "0.42.0",
    csrf: "c".repeat(22),
  });
}

describe("pair requests", () => {
  it("stores hashes, never the code, state or csrf", async () => {
    const pw = await pairWorld();
    const id = await pending(pw);
    expect(await approve(pw.w.ctx, id, "k".repeat(43))).toBe(true);
    const row = await pw.w.ctx.db.prepare("SELECT * FROM pair_requests WHERE id = ?").bind(id).first<Record<string, unknown>>();
    const flat = JSON.stringify(row);
    expect(flat).not.toContain("k".repeat(43));
    expect(flat).not.toContain("s".repeat(32));
    expect(flat).not.toContain("c".repeat(22));
  });
  it("transitions are guarded: approve once, claim once, deny only while pending", async () => {
    const pw = await pairWorld();
    const id = await pending(pw);
    const k = randomToken();
    expect(await approve(pw.w.ctx, id, k)).toBe(true);
    expect(await approve(pw.w.ctx, id, randomToken())).toBe(false);
    expect(await deny(pw.w.ctx, id)).toBe(false);
    const [a, b] = await Promise.all([claim(pw.w.ctx, id, k), claim(pw.w.ctx, id, k)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
  it("a code lives 120 s and a request 10 minutes", async () => {
    const pw = await pairWorld();
    const id = await pending(pw);
    const k = randomToken();
    await approve(pw.w.ctx, id, k);
    pw.w.clock.now += 120;
    expect(await findByCode(pw.w.ctx, k)).not.toBeNull();
    pw.w.clock.now += 1;
    expect(await findByCode(pw.w.ctx, k)).toBeNull();
    const late = await pending(pw);
    pw.w.clock.now += 601;
    expect(await approve(pw.w.ctx, late, randomToken())).toBe(false);
    expect(await expire(pw.w.ctx, late)).toBe(true);
  });
});

describe("runPairSweep", () => {
  it("expires abandoned pairings, tears down their awaiting_claim machines and audits pair.expired", async () => {
    const pw = await pairWorld();
    const { machineId } = await approvePairing(pw, await fixtureMachine());
    await getAuthorize(pw, authorizeQuery(await fixtureMachine("desk")));
    await pw.w.ctx.db
      .prepare("INSERT INTO handoff_csrf (token_hash, state_hash, pk_thumbprint, dk_fingerprint, verified, user_id, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .bind(new Uint8Array(32).fill(7), new Uint8Array(32), "t".repeat(43), "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA", pw.user.id, pw.w.clock.now + 600)
      .run();
    // D1 storage is shared within this file, so earlier tests' rows may expire too.
    await runPairSweep(pw.w.ctx, 100);
    pw.w.clock.now += 601;
    const r = await runPairSweep(pw.w.ctx, 100);
    expect(r.expired).toBeGreaterThanOrEqual(2);
    expect(r.csrfPurged).toBeGreaterThanOrEqual(1);
    expect(pw.w.prov.calls.filter((c) => c.fn === "startTeardown").map((c) => c.args)).toContainEqual([machineId, "stale"]);
    expect(pw.w.audit.filter((a) => a.action === "pair.expired" && a.target.id === machineId)).toHaveLength(1);
    expect(pw.w.audit.find((a) => a.action === "pair.expired")!.actor).toEqual({ kind: "system", id: null });
    const statuses = await pw.w.ctx.db.prepare("SELECT status FROM pair_requests WHERE user_id = ?").bind(pw.user.id).all<{ status: string }>();
    expect(statuses.results.map((s) => s.status)).toEqual(["expired", "expired"]);
  });
  it("leaves a claimed pairing's active machine alone", async () => {
    const pw = await pairWorld();
    await approvePairing(pw, await fixtureMachine());
    await pw.w.ctx.db.prepare("UPDATE pair_requests SET status = 'claimed' WHERE user_id = ?").bind(pw.user.id).run();
    pw.w.clock.now += 601;
    expect((await runPairSweep(pw.w.ctx)).expired).toBe(0);
  });
});
