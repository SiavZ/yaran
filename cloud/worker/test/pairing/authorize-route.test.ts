/**
 * W2/W3 end to end through the fake pipeline: who may pair, the policy, the cap, the
 * same-name branch, Deny, the provisioning failure and its idempotent Retry, the exact
 * callback redirect and the confirm page's headers and accessibility attributes.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/authorize-route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/sig/fingerprint.json
 * ├── src/pairing/authorize-route.ts
 * ├── test/pairing/pair-helpers.ts
 * └── test/phase06/fakes.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import fingerprints from "@yaran/protocol/fixtures/sig/fingerprint.json" with { type: "json" };
import { b64urlDecode } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { nextFreeName } from "../../src/pairing/authorize-route.ts";
import { seedMachine, seedUser } from "../phase06/fakes.ts";
import { approvePairing, authorizeQuery, fixtureMachine, formFields, getAuthorize, pairWorld, postAuthorize, userJwt } from "./pair-helpers.ts";

const location = (r: Response) => new URL(r.headers.get("Location")!);

describe("GET /v1/pair/authorize: who may pair", () => {
  it("renders the confirm page for an active user's JWT", async () => {
    const pw = await pairWorld();
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine()));
    expect(res.status).toBe(200);
    expect(pw.w.audit.map((a) => a.action)).toEqual(["pair.requested"]);
  });
  it.each([
    ["no JWT", null, 401],
    ["a service token", "service", 403],
    ["another AUD", "aud", 401],
  ])("refuses %s", async (_n, kind, status) => {
    const pw = await pairWorld();
    const jwt = kind === null ? null : kind === "service" ? userJwt("", { common_name: "svc.access", email: undefined }) : userJwt(pw.user.email, { aud: ["machine-app-aud"] });
    expect((await getAuthorize(pw, authorizeQuery(await fixtureMachine()), jwt)).status).toBe(status);
  });
  it("refuses a disabled user", async () => {
    const pw = await pairWorld();
    const off = await seedUser(pw.w.ctx.db, `off-${crypto.randomUUID().slice(0, 6)}@example.org`, { status: "disabled" });
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine()), userJwt(off.email));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("user_disabled");
  });
});

describe("GET refusals", () => {
  it("answers a 400 page with no Location for a bad callback", async () => {
    const pw = await pairWorld();
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine(), { callback: "http://localhost:4000/callback" }));
    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
    expect(await res.text()).toContain("pair_callback_invalid");
  });
  it("redirects other refusals to the validated callback with error and state", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const res = await getAuthorize(pw, authorizeQuery(m, { machine_name: "Not_Valid" }));
    expect(res.status).toBe(302);
    const loc = location(res);
    expect(`${loc.origin}${loc.pathname}`).toBe(`http://127.0.0.1:${m.port}/callback`);
    expect(Object.fromEntries(loc.searchParams)).toEqual({ error: "machine_name_invalid", state: m.state });
  });
  it("adds min and max for an unsupported protocol", async () => {
    const pw = await pairWorld();
    const loc = location(await getAuthorize(pw, authorizeQuery(await fixtureMachine(), { v: "7" })));
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ error: "protocol_unsupported", min: "1", max: "1" });
  });
  it("applies the allowlist policy: listed email and domain pass, others get pairing_not_allowed", async () => {
    const pw = await pairWorld();
    pw.w.settings.pairing_policy = { mode: "allowlist", emails: [pw.user.email], domains: [], access_group_ids: [] };
    expect((await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).status).toBe(200);
    pw.w.settings.pairing_policy = { mode: "allowlist", emails: [], domains: ["example.org"], access_group_ids: [] };
    expect((await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).status).toBe(200);
    pw.w.settings.pairing_policy = { mode: "allowlist", emails: ["someone@else.org"], domains: ["example.com"], access_group_ids: [] };
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine()));
    expect(location(res).searchParams.get("error")).toBe("pairing_not_allowed");
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "pair.refused", detail: { reason: "policy" } });
  });
  it("enforces the machine cap at GET", async () => {
    const pw = await pairWorld();
    pw.w.settings.machine_cap_per_user = 1;
    await seedMachine(pw.w.ctx.db, pw.user, { name: "other" });
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine()));
    expect(location(res).searchParams.get("error")).toBe("machine_cap_reached");
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "pair.refused", detail: { reason: "cap", limit: 1 } });
  });
});

describe("the confirm page", () => {
  it("shows the 02 §7.1 fingerprint as a mono chip, with focus on Approve", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const fx = fingerprints.cases[0]!;
    // Pin the rendered string to the shared fixture's key.
    const res = await getAuthorize(pw, authorizeQuery(m, { machine_pubkey: fx.public_key }));
    const html = await res.text();
    expect(html).toContain(`<code class="chip chip-mono" aria-label="Machine key fingerprint">${fx.fingerprint}</code>`);
    expect(html).toContain(`<code class="chip">${pw.user.email}</code>`);
    expect(html).toContain(`<code class="chip">laptop</code>`);
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toMatch(/<button type="submit" class="btn btn-primary" name="decision" value="approve" autofocus>Approve<\/button>/);
    expect(html).toMatch(/<form method="post" action="\/v1\/pair\/authorize" aria-label="Pairing decision">/);
    expect(b64urlDecode(fx.public_key)!.length).toBe(32);
  });
  it("carries Referrer-Policy same-origin and form-action for the validated loopback port", async () => {
    const pw = await pairWorld();
    const res = await getAuthorize(pw, authorizeQuery(await fixtureMachine("laptop", 51234)));
    expect(res.headers.get("Referrer-Policy")).toBe("same-origin");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("form-action 'self' http://127.0.0.1:51234");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("offers Replace (focused) and Pair-as when the name is already active", async () => {
    const pw = await pairWorld();
    const old = await seedMachine(pw.w.ctx.db, pw.user, { name: "laptop" });
    const html = await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text();
    expect(html).toContain(`name="replace_machine_id" value="${old}" autofocus>Replace laptop</button>`);
    expect(html).toContain(">Pair as laptop-2</button>");
  });
});

describe("POST /v1/pair/authorize", () => {
  it("approves: 302 Location is exactly the callback with a 43-char code and the state", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const { location: loc, machineId } = await approvePairing(pw, m);
    const u = new URL(loc);
    expect(`${u.origin}${u.pathname}`).toBe(`http://127.0.0.1:${m.port}/callback`);
    expect([...u.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(u.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")).toBe(m.state);
    expect(pw.w.prov.calls.map((c) => c.fn)).toEqual(["startProvision", "driveOp"]);
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "pair.approved", target: { kind: "machine", id: machineId } });
    const row = await pw.w.ctx.db.prepare("SELECT code_hash, status FROM pair_requests WHERE machine_id = ?").bind(machineId).first<{ code_hash: ArrayBuffer; status: string }>();
    expect(row!.status).toBe("confirmed");
    expect(new Uint8Array(row!.code_hash).length).toBe(32);
  });
  it("Deny redirects with pair_denied and audits it", async () => {
    const pw = await pairWorld();
    const m = await fixtureMachine();
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(m))).text());
    const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "deny" });
    expect(Object.fromEntries(location(res).searchParams)).toEqual({ error: "pair_denied", state: m.state });
    expect(pw.w.audit.at(-1)!.action).toBe("pair.denied");
    expect(pw.w.prov.calls).toEqual([]);
  });
  it("refuses a wrong csrf, a foreign Origin and the replace field with deny", async () => {
    const pw = await pairWorld();
    const old = await seedMachine(pw.w.ctx.db, pw.user, { name: "laptop" });
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    expect((await postAuthorize(pw, { request_id: f["request_id"]!, csrf: "x".repeat(22), decision: "approve" })).status).toBe(400);
    expect((await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" }, "null")).status).toBe(403);
    const deny = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "deny", replace_machine_id: old });
    expect(deny.status).toBe(400);
    expect(await deny.text()).toContain("pair_request_invalid");
  });
  it("a provisioning failure renders Retry, and Retry reuses the same machine id", async () => {
    const pw = await pairWorld();
    pw.w.prov.nextDrive = { state: "failed", errorCode: "account_quota_reached", details: { resource: "access_apps", used: 500, limit: 500 } };
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    const fail = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" });
    expect(fail.status).toBe(409);
    const html = await fail.text();
    expect(html).toContain("This org has used 500 of 500 Access applications. Ask an admin to remove unused machines");
    expect(html).toContain(">Retry</button>");
    expect(pw.w.audit.at(-1)).toMatchObject({ action: "pair.refused", detail: { reason: "quota" } });
    pw.w.prov.nextDrive = { state: "complete", errorCode: null };
    const retry = formFields(html);
    const ok = await postAuthorize(pw, retry);
    expect(ok.status).toBe(302);
    const ids = pw.w.prov.calls.filter((c) => c.fn === "startProvision").map((c) => c.args[0]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });
  it("an op still running answers provisioning_in_progress with Retry", async () => {
    const pw = await pairWorld();
    pw.w.prov.nextDrive = { state: "in_progress", errorCode: null };
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("provisioning_in_progress");
  });
  it("enforces the cap again atomically at approve", async () => {
    const pw = await pairWorld();
    pw.w.settings.machine_cap_per_user = 1;
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    await seedMachine(pw.w.ctx.db, pw.user, { name: "raced" });
    const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" });
    expect(location(res).searchParams.get("error")).toBe("machine_cap_reached");
    expect(pw.w.prov.calls).toEqual([]);
  });
  it("replace_machine_id naming the caller's same-name machine is accepted, even at the cap", async () => {
    const pw = await pairWorld();
    pw.w.settings.machine_cap_per_user = 1;
    const old = await seedMachine(pw.w.ctx.db, pw.user, { name: "laptop" });
    const { machineId } = await approvePairing(pw, await fixtureMachine(), { replace_machine_id: old });
    const row = await pw.w.ctx.db.prepare("SELECT name FROM machines WHERE id = ?").bind(machineId).first<{ name: string }>();
    expect(row!.name).toBe("laptop");
    const oldRow = await pw.w.ctx.db.prepare("SELECT status FROM machines WHERE id = ?").bind(old).first<{ status: string }>();
    expect(oldRow!.status).toBe("active");
  });
  it("Pair-as gives the new machine the next free name", async () => {
    const pw = await pairWorld();
    await seedMachine(pw.w.ctx.db, pw.user, { name: "laptop" });
    const { machineId } = await approvePairing(pw, await fixtureMachine());
    const row = await pw.w.ctx.db.prepare("SELECT name FROM machines WHERE id = ?").bind(machineId).first<{ name: string }>();
    expect(row!.name).toBe("laptop-2");
  });
  it.each(["another user's machine", "a different name"])("replace_machine_id naming %s is pair_request_invalid", async (which) => {
    const pw = await pairWorld();
    const other = await seedUser(pw.w.ctx.db, `other-${crypto.randomUUID().slice(0, 6)}@example.org`);
    const target = which === "a different name" ? await seedMachine(pw.w.ctx.db, pw.user, { name: "desktop" }) : await seedMachine(pw.w.ctx.db, other, { name: "laptop" });
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve", replace_machine_id: target });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("pair_request_invalid");
  });
  it("refuses a pair request older than 10 minutes", async () => {
    const pw = await pairWorld();
    const f = formFields(await (await getAuthorize(pw, authorizeQuery(await fixtureMachine()))).text());
    pw.w.clock.now += 601;
    const res = await postAuthorize(pw, { request_id: f["request_id"]!, csrf: f["csrf"]!, decision: "approve" });
    expect(res.status).toBe(410);
  });
});

describe("nextFreeName", () => {
  it("skips taken suffixes and stays a valid 32-char MachineName", () => {
    expect(nextFreeName("laptop", new Set(["laptop", "laptop-2"]))).toBe("laptop-3");
    const long = "a".repeat(31) + "b";
    expect(nextFreeName(long, new Set([long]))).toBe("a".repeat(30) + "-2");
    expect(nextFreeName("ab-" + "c".repeat(27) + "d", new Set())).toMatch(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/);
  });
});
