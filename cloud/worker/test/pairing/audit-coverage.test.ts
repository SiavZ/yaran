/**
 * Audit coverage: drives every Phase 06 route through one world and asserts that each
 * state change wrote exactly its listed event, and that no audit detail carries secret
 * material (a regex sweep for JWTs, base64url runs of 40+ characters and https URLs).
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/audit-coverage.test.ts
 * ├── src/pairing/sweep.ts
 * ├── src/routes/pairing-and-sessions.ts
 * ├── test/devices/device-fixtures.ts
 * ├── test/pairing/pair-helpers.ts
 * ├── test/phase06/fakes.ts
 * ├── test/phase06/harness.ts
 * └── test/sessions/handoff-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { PHASE06_ROUTES } from "../../src/routes/pairing-and-sessions.ts";
import { runPairSweep } from "../../src/pairing/sweep.ts";
import { registration } from "../devices/device-fixtures.ts";
import { CP_HOST } from "../phase06/fakes.ts";
import { dispatch } from "../phase06/harness.ts";
import { formFromPage, get, handoffQuery, makePhone, post } from "../sessions/handoff-helpers.ts";
import {
  approvePairing,
  authorizeQuery,
  claimBody,
  claimRequest,
  fixtureMachine,
  formFields,
  getAuthorize,
  machineCall,
  pairedMachine,
  pairWorld,
  postAuthorize,
  type PairWorld,
} from "./pair-helpers.ts";

const SECRET_PATTERNS = [/eyJ[A-Za-z0-9_-]+\./, /[A-Za-z0-9_-]{40,}/, /https?:\/\//];

/** Runs `step` and returns the audit actions it wrote. */
async function written(pw: PairWorld, step: () => Promise<unknown>): Promise<string[]> {
  const before = pw.w.audit.length;
  await step();
  return pw.w.audit.slice(before).map((a) => a.action);
}

function api(pw: PairWorld, method: string, path: string, body?: unknown, installId?: string): Promise<Response> {
  const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": pw.jwt, "Yaran-Protocol": "1" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (installId) headers["Yaran-Install-Id"] = installId;
  return dispatch(PHASE06_ROUTES, new Request(`https://${CP_HOST}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), pw.w.ctx);
}

describe("audit coverage", () => {
  it("every state change writes exactly its event and no detail carries a secret", async () => {
    const pw = await pairWorld();

    // Pairing.
    const bad = await fixtureMachine();
    expect(await written(pw, () => getAuthorize(pw, authorizeQuery(bad, { machine_name: "Nope_" })))).toEqual(["pair.refused"]);
    const denied = await fixtureMachine("denied");
    let fields: Record<string, string> = {};
    expect(await written(pw, async () => (fields = formFields(await (await getAuthorize(pw, authorizeQuery(denied))).text())))).toEqual(["pair.requested"]);
    expect(await written(pw, () => postAuthorize(pw, { request_id: fields["request_id"]!, csrf: fields["csrf"]!, decision: "deny" }))).toEqual(["pair.denied"]);

    const m = await fixtureMachine();
    let code = "";
    let machineId = "";
    expect(await written(pw, async () => ({ code, machineId } = await approvePairing(pw, m)))).toEqual(["pair.requested", "pair.approved"]);
    expect(await written(pw, () => claimRequest(pw, m, claimBody(m, code)))).toEqual(["machine.claimed"]);

    pw.w.prov.nextDrive = { state: "failed", errorCode: "provisioning_failed" };
    const failing = await fixtureMachine("failing");
    expect(
      await written(pw, async () => {
        const f = formFields(await (await getAuthorize(pw, authorizeQuery(failing))).text());
        await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" });
      }),
    ).toEqual(["pair.requested", "pair.provision_failed"]);
    pw.w.prov.nextDrive = { state: "complete", errorCode: null };

    const again = await fixtureMachine();
    expect(
      await written(pw, async () => {
        const r = await approvePairing(pw, again, { replace_machine_id: machineId });
        await claimRequest(pw, again, claimBody(again, r.code));
        machineId = r.machineId;
      }),
    ).toEqual(["pair.requested", "pair.approved", "machine.claimed", "machine.replaced"]);

    // Machine API.
    expect(await written(pw, () => machineCall(pw, again, machineId, "GET", "/v1/machine/config"))).toEqual([]);
    expect(await written(pw, () => machineCall(pw, again, machineId, "POST", "/v1/machine/rotate", { known_token_version: 1, reason: "user" }))).toEqual(["machine.rotated"]);
    expect(await written(pw, () => machineCall(pw, again, machineId, "POST", "/v1/machine/rotate", { known_token_version: 1, reason: "sync" }))).toEqual([]);
    expect(await written(pw, () => machineCall(pw, again, machineId, "PUT", "/v1/machine/origin", { origin_port: 4100 }))).toEqual(["machine.origin_changed"]);
    expect(await written(pw, () => machineCall(pw, again, machineId, "PUT", "/v1/machine/origin", { origin_port: 4100 }))).toEqual([]);
    expect(await written(pw, () => machineCall(pw, again, machineId, "POST", "/v1/machine/unpair"))).toEqual(["machine.unpaired"]);

    // User machine routes.
    const owned = await pairedMachine(pw, "desk");
    expect(await written(pw, () => api(pw, "GET", "/v1/me/machines"))).toEqual([]);
    expect(await written(pw, () => api(pw, "DELETE", `/v1/me/machines/${owned.machineId}`))).toEqual(["machine.unpaired"]);

    // Handoff.
    const s = { w: pw.w, user: pw.user, jwt: pw.jwt, phone: await makePhone() };
    let page: Response | null = null;
    expect(await written(pw, async () => (page = await get(s, await handoffQuery(s))))).toEqual([]);
    expect(await written(pw, async () => post(s, await formFromPage(page!, "continue")))).toEqual(["handoff.issued"]);
    page = await get(s, await handoffQuery(s, { state: "YW5vdGhlci1zdGF0ZS1mb3ItY2FuY2Vs" }));
    expect(await written(pw, async () => post(s, await formFromPage(page!, "cancel")))).toEqual(["handoff.declined"]);

    // Devices.
    const reg = await registration();
    let deviceId = "";
    expect(await written(pw, async () => (deviceId = ((await (await api(pw, "POST", "/v1/me/devices", reg, reg.install_id)).json()) as { id: string }).id))).toEqual(["device.registered"]);
    expect(await written(pw, () => api(pw, "POST", "/v1/me/devices", { ...reg, label: "Renamed" }, reg.install_id))).toEqual(["device.updated"]);
    expect(await written(pw, () => api(pw, "PATCH", `/v1/me/devices/${deviceId}`, { mute_all: true }, reg.install_id))).toEqual(["device.updated"]);
    expect(await written(pw, () => api(pw, "GET", "/v1/me/devices", undefined, reg.install_id))).toEqual([]);
    pw.w.settings.device_cap_per_user = 1;
    const second = await registration({ device_key: (await registration()).push.keys.p256dh });
    expect(await written(pw, () => api(pw, "POST", "/v1/me/devices", second, second.install_id))).toEqual(["device.cap_refused"]);
    expect((await written(pw, () => api(pw, "DELETE", `/v1/me/devices/${deviceId}?sign_out_everywhere=1`))).sort()).toEqual(["device.revoked", "sessions.revoked"]);

    // Sweep.
    await getAuthorize(pw, authorizeQuery(await fixtureMachine("abandoned")));
    pw.w.clock.now += 601;
    const swept = await written(pw, () => runPairSweep(pw.w.ctx, 100));
    expect(swept.length).toBeGreaterThan(0);
    expect(new Set(swept)).toEqual(new Set(["pair.expired"]));

    // Nothing secret in any detail, and every row targets something.
    for (const a of pw.w.audit) {
      const detail = JSON.stringify(a.detail ?? {});
      for (const re of SECRET_PATTERNS) expect(detail, `${a.action} detail ${detail}`).not.toMatch(re);
      expect(a.target.kind).toBeTruthy();
    }
    const actions = new Set(pw.w.audit.map((a) => a.action));
    for (const want of [
      "pair.requested", "pair.approved", "pair.denied", "pair.refused", "pair.expired", "pair.provision_failed", "machine.claimed",
      "machine.replaced", "machine.rotated", "machine.origin_changed", "machine.unpaired", "handoff.issued", "handoff.declined",
      "device.registered", "device.updated", "device.revoked", "device.cap_refused", "sessions.revoked",
    ]) expect(actions, want).toContain(want);
  });
});
