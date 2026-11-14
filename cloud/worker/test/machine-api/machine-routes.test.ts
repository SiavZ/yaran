/**
 * W5, W7, W8 and W32 on a machine paired end to end: config (and 410 once revoked),
 * rotate (user and sync), unpair (202 then 410) and origin (changed or not, refusals).
 *
 * <module-headers:begin>
 * Uses:
 * test/machine-api/machine-routes.test.ts
 * ├── @yaran/protocol:src/index.ts
 * └── test/pairing/pair-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { machineCall, pairedMachine, pairWorld } from "../pairing/pair-helpers.ts";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe("GET /v1/machine/config", () => {
  it("answers a schema-valid MachineConfig without the token and stamps last_seen", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    pw.w.clock.now += 400;
    const res = await machineCall(pw, m, machineId, "GET", "/v1/machine/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(validate("MachineConfig", body).valid).toBe(true);
    expect(JSON.stringify(body)).not.toContain("tunnel-token");
    expect(body).toMatchObject({ machine_id: machineId, tunnel: { token_version: 1 }, push: { enabled: true, detail: "names" }, events: { max_batch: 16 } });
    const row = await pw.w.ctx.db.prepare("SELECT last_seen_at, reported_protocol FROM machines WHERE id = ?").bind(machineId).first();
    expect(row).toEqual({ last_seen_at: pw.w.clock.now, reported_protocol: 1 });
  });
  it("throttles the last_seen write to once per 5 minutes", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const claimed = pw.w.clock.now;
    pw.w.clock.now += 100;
    await machineCall(pw, m, machineId, "GET", "/v1/machine/config");
    const row = await pw.w.ctx.db.prepare("SELECT last_seen_at FROM machines WHERE id = ?").bind(machineId).first<{ last_seen_at: number }>();
    expect(row!.last_seen_at).toBe(claimed);
  });
  it("a revoked machine gets 410 machine_revoked", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    await pw.w.ctx.db.prepare("UPDATE machines SET status = 'revoked' WHERE id = ?").bind(machineId).run();
    const res = await machineCall(pw, m, machineId, "GET", "/v1/machine/config");
    expect(res.status).toBe(410);
    expect(await code(res)).toBe("machine_revoked");
  });
});

describe("POST /v1/machine/rotate", () => {
  it("reason user rotates, bumps token_version and audits machine.rotated", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const res = await machineCall(pw, m, machineId, "POST", "/v1/machine/rotate", { known_token_version: 1, reason: "user" });
    const body = (await res.json()) as { rotated: boolean; tunnel: { token_version: number } };
    expect(validate("RotateResponse", body).valid).toBe(true);
    expect(body).toMatchObject({ rotated: true, tunnel: { token_version: 2 } });
    expect(pw.w.prov.calls.at(-1)).toEqual({ fn: "rotateTunnelSecret", args: [machineId, { evict: false }] });
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "machine.rotated", actor: { kind: "machine", id: machineId } });
  });
  it("reason sync returns the current token without rotating or auditing", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const before = pw.w.audit.length;
    const res = await machineCall(pw, m, machineId, "POST", "/v1/machine/rotate", { known_token_version: 1, reason: "sync" });
    expect(await res.json()).toMatchObject({ rotated: false, tunnel: { token_version: 1 } });
    expect(pw.w.audit.length).toBe(before);
  });
});

describe("POST /v1/machine/unpair", () => {
  it("answers 202 TeardownStarted, then 410 machine_revoked", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const first = await machineCall(pw, m, machineId, "POST", "/v1/machine/unpair");
    expect(first.status).toBe(202);
    const body = await first.json();
    expect(validate("TeardownStarted", body).valid).toBe(true);
    expect(body).toEqual({ machine_id: machineId, state: "tearing_down" });
    expect(pw.w.prov.calls.at(-1)).toEqual({ fn: "startTeardown", args: [machineId, "machine_logout"] });
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "machine.unpaired", actor: { kind: "machine" } });
    const again = await machineCall(pw, m, machineId, "POST", "/v1/machine/unpair");
    expect(again.status).toBe(410);
    expect(await code(again)).toBe("machine_revoked");
  });
});

describe("PUT /v1/machine/origin", () => {
  it("the same port → changed:false with no 05 call", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const res = await machineCall(pw, m, machineId, "PUT", "/v1/machine/origin", { origin_port: 3890 });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ origin_port: 3890, changed: false });
    expect(pw.w.prov.calls.some((c) => c.fn === "setOriginPort")).toBe(false);
  });
  it("a new port → changed:true, setOriginPort called, machine.origin_changed audited", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    const res = await machineCall(pw, m, machineId, "PUT", "/v1/machine/origin", { origin_port: 4500 });
    expect(await res.json()).toEqual({ origin_port: 4500, changed: true });
    expect(pw.w.prov.calls.at(-1)).toEqual({ fn: "setOriginPort", args: [machineId, 4500] });
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "machine.origin_changed", detail: { from: 3890, to: 4500 } });
  });
  it("port 0 is origin_port_invalid; a live op is 409 provisioning_in_progress", async () => {
    const pw = await pairWorld();
    const { m, machineId } = await pairedMachine(pw);
    expect(await code(await machineCall(pw, m, machineId, "PUT", "/v1/machine/origin", { origin_port: 0 }))).toBe("origin_port_invalid");
    pw.w.prov.originBusy = true;
    const busy = await machineCall(pw, m, machineId, "PUT", "/v1/machine/origin", { origin_port: 4600 });
    expect(busy.status).toBe(409);
    expect(await code(busy)).toBe("provisioning_in_progress");
  });
});
