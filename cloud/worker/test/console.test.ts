/**
 * The consoles and the admin API through their route rows: the authz matrix, confirm pages
 * for every destructive action, gone targets, outcome notices, JSON rules and response
 * schemas, push_state wording, and the CSP and accessibility checks on every page.
 *
 * <module-headers:begin>
 * Uses:
 * test/console.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin-api/routes.ts
 * ├── src/console/admin-routes.ts
 * ├── src/console/route-types.ts
 * ├── src/console/routes.ts
 * ├── src/phase07.ts
 * ├── src/setup/steps/common.ts
 * ├── test/helpers/deps.ts
 * └── test/helpers/html-checks.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { machineKeyFingerprint, validate } from "@yaran/protocol";
import { ADMIN_API_ROUTES } from "../src/admin-api/routes.ts";
import { ADMIN_ROUTES } from "../src/console/admin-routes.ts";
import type { RouteRow } from "../src/console/route-types.ts";
import { USER_ROUTES } from "../src/console/routes.ts";
import { PHASE07_ROUTES } from "../src/phase07.ts";
import { advance } from "../src/setup/steps/common.ts";
import { a11yViolations, cspViolations } from "./helpers/html-checks.ts";
import { closedOrg, dispatch, MACHINE_ID, seedDevice, seedMachine, seedUser, world, type TestWorld } from "./helpers/deps.ts";

const CP = "https://cp.example.org";
const ADA = { user_id: "00000000-0000-4000-8000-0000000000a1", email: "ada@example.org", role: "admin" as const };
const BOB = { user_id: "00000000-0000-4000-8000-0000000000b2", email: "bob@example.org", role: "user" as const };

let machineKey: Uint8Array = new Uint8Array();

async function ready(): Promise<TestWorld> {
  const w = await world();
  await advance(w.db, { step: "token" }, { kind: "probe_ok", account_id: "acc1", admin_email: "ada@example.org", script_name: "yaran-cloud" }, w.clock.now);
  await closedOrg(w);
  await seedUser(w, "ada@example.org", "admin");
  await seedUser(w, "bob@example.org");
  machineKey = await seedMachine(w);
  await seedDevice(w);
  return w;
}

const machineRow = (w: TestWorld) => w.db.prepare("SELECT status, revoke_reason FROM machines WHERE id = ?").bind(MACHINE_ID).first<{ status: string; revoke_reason: string | null }>();

// Who may call each row is 04's authz matrix (test/authz-matrix.test.ts), which iterates
// the production table, these rows included.
describe("route rows", () => {
  test("every row declares the auth class its path family requires", () => {
    for (const r of PHASE07_ROUTES) {
      const want = r.path.startsWith("/setup") ? "setup" : r.path.startsWith("/admin") || r.path.startsWith("/v1/admin") ? "admin" : "user";
      expect(`${r.method} ${r.path} ${r.auth.kind}`).toBe(`${r.method} ${r.path} ${want}`);
      expect(r.kind).toBe(r.path.startsWith("/v1/") ? "json" : "html");
    }
  });
});

const DESTRUCTIVE = /\/(unpair|remove|disable|revoke|rotate)$/;

describe("destructive actions", () => {
  const html = [...USER_ROUTES, ...ADMIN_ROUTES];
  test("every destructive POST has a GET confirm page at the same path", () => {
    const posts = html.filter((r) => r.method === "POST" && DESTRUCTIVE.test(r.path));
    expect(posts.length).toBe(6);
    for (const p of posts) expect(html.some((r) => r.method === "GET" && r.path === p.path)).toBe(true);
  });
  test.each(html.filter((r) => r.method === "POST").map((r) => [r.path, r] as const))("POST %s refuses a foreign Origin", async (path, _r) => {
    const w = await ready();
    const url = CP + path.replace(":id", "00000000-0000-4000-8000-000000000101");
    const res = await dispatch(html, w, "POST", url, { identity: ADA, headers: { Origin: "https://evil.example" }, body: new URLSearchParams() });
    expect(res.status).toBe(403);
    expect([w.cf.calls, w.prov.calls]).toEqual([[], []]);
    expect(await machineRow(w)).toEqual({ status: "active", revoke_reason: null });
  });
  test("a gone target's confirm page says already removed", async () => {
    const w = await ready();
    for (const path of ["/admin/machines/zz/revoke", "/admin/devices/zz/remove", "/console/machines/zz/unpair", "/admin/users/zz/disable"]) {
      const text = await (await dispatch(html, w, "GET", CP + path, { identity: ADA })).text();
      expect(text).toContain("was already removed");
      expect(text).not.toContain("btn-destructive");
    }
  });
  test("the outcome is a notice that names the target", async () => {
    const w = await ready();
    const res = await dispatch(html, w, "POST", `${CP}/admin/machines/00000000-0000-4000-8000-000000000101/revoke`, { identity: ADA, headers: { Origin: CP }, body: new URLSearchParams() });
    expect(res.status).toBe(303);
    expect((await machineRow(w))!.revoke_reason).toBe("admin_revoke");
    const audited = await w.db.prepare("SELECT action, target_id FROM audit_log WHERE action = 'machine.revoked'").all();
    expect(audited.results).toEqual([{ action: "machine.revoked", target_id: MACHINE_ID }]);
    const cookie = res.headers.get("Set-Cookie")!.split(";")[0]!;
    const page = await (await dispatch(html, w, "GET", `${CP}/admin/machines`, { identity: ADA, headers: { Cookie: cookie } })).text();
    expect(page).toContain('Revoking the machine <code class="chip">laptop</code>');
  });
  test("rotate maps kill_connections to evict", async () => {
    const w = await ready();
    await dispatch(html, w, "POST", `${CP}/admin/machines/00000000-0000-4000-8000-000000000101/rotate`, { identity: ADA, headers: { Origin: CP }, body: new URLSearchParams({ kill_connections: "on" }) });
    const op = await w.db.prepare("SELECT params FROM provisioning_ops WHERE machine_id = ? AND kind = 'rotate'").bind(MACHINE_ID).first<{ params: string }>();
    expect(JSON.parse(op!.params)).toMatchObject({ evict: true });
  });
  test("a user cannot unpair someone else's machine", async () => {
    const w = await ready();
    const text = await (await dispatch(html, w, "POST", `${CP}/console/machines/00000000-0000-4000-8000-000000000101/unpair`, { identity: BOB, headers: { Origin: CP }, body: new URLSearchParams() })).text();
    expect(text).toContain("was already removed");
    expect(await machineRow(w)).toEqual({ status: "active", revoke_reason: null });
  });
});

describe("pages", () => {
  const pages: [string, typeof ADA | typeof BOB][] = [
    ["/console", ADA], ["/console/phones", ADA], ["/console/connect", ADA], ["/console/machines/00000000-0000-4000-8000-000000000101/unpair", ADA], ["/console/phones/00000000-0000-4000-8000-000000000201/remove", ADA],
    ["/admin/users", ADA], ["/admin/users/00000000-0000-4000-8000-0000000000b2/disable", ADA], ["/admin/machines", ADA], ["/admin/machines/00000000-0000-4000-8000-000000000101/revoke", ADA],
    ["/admin/machines/00000000-0000-4000-8000-000000000101/rotate", ADA], ["/admin/devices", ADA], ["/admin/devices/00000000-0000-4000-8000-000000000201/remove", ADA], ["/admin/audit", ADA],
    ["/admin/settings", ADA], ["/admin/health", ADA], ["/admin/updates", ADA],
  ];
  test.each(pages)("%s passes the CSP and accessibility checks", async (path, who) => {
    const w = await ready();
    const res = await dispatch([...USER_ROUTES, ...ADMIN_ROUTES], w, "GET", CP + path, { identity: who });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(cspViolations(html)).toEqual([]);
    expect(a11yViolations(html)).toEqual([]);
  });
  test("phones lists word push_state", async () => {
    const w = await ready();
    expect(await (await dispatch(USER_ROUTES, w, "GET", `${CP}/console/phones`, { identity: ADA })).text()).toContain("push stopped: the subscription expired");
    expect(await (await dispatch(ADMIN_ROUTES, w, "GET", `${CP}/admin/devices`, { identity: ADA })).text()).toContain("push stopped: the subscription expired");
  });
  test("machines say how to rename and the admin list shows the key fingerprint and origin port", async () => {
    const w = await ready();
    expect(await (await dispatch(USER_ROUTES, w, "GET", `${CP}/console`, { identity: ADA })).text()).toContain("unpair it and pair it again");
    const admin = await (await dispatch(ADMIN_ROUTES, w, "GET", `${CP}/admin/machines`, { identity: ADA })).text();
    expect(admin).toContain(await machineKeyFingerprint(machineKey));
    expect(admin).toContain("<td>8080</td>");
  });
});

describe("admin API", () => {
  const send = (w: TestWorld, method: string, path: string, body?: unknown, headers: Record<string, string> = { "Content-Type": "application/json", Origin: CP }) =>
    dispatch(ADMIN_API_ROUTES, w, method, CP + path, { identity: ADA, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

  test.each([
    ["/v1/admin/users", "AdminUserPage"],
    ["/v1/admin/machines", "AdminMachinePage"],
    ["/v1/admin/devices", "AdminDevicePage"],
    ["/v1/admin/audit", "AuditPage"],
    ["/v1/admin/settings", "Settings"],
    ["/v1/admin/update-status", "UpdateStatus"],
  ])("GET %s validates as %s", async (path, type) => {
    const w = await ready();
    const res = await send(w, "GET", path, undefined, {});
    expect(res.status).toBe(200);
    expect(validate(type, await res.json()).errors).toEqual([]);
  });
  test("refuses a non-JSON body and a foreign Origin", async () => {
    const w = await ready();
    const plain = await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000b2", { role: "admin" }, { "Content-Type": "text/plain", Origin: CP });
    expect(plain.status).toBe(415);
    expect(((await plain.json()) as { error: { code: string } }).error.code).toBe("unsupported_media_type");
    const foreign = await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000b2", { role: "admin" }, { "Content-Type": "application/json", Origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(((await foreign.json()) as { error: { code: string } }).error.code).toBe("origin_mismatch");
  });
  test("PATCH validates the body, answers AdminUser, and refuses the last admin", async () => {
    const w = await ready();
    expect((await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000b2", {})).status).toBe(400);
    const ok = await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000b2", { role: "admin" });
    expect(validate("AdminUser", await ok.json()).valid).toBe(true);
    await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000b2", { role: "user" });
    const last = await send(w, "PATCH", "/v1/admin/users/00000000-0000-4000-8000-0000000000a1", { role: "user" });
    expect(last.status).toBe(409);
    expect(((await last.json()) as { error: { code: string } }).error.code).toBe("last_admin");
  });
  test("DELETE machine answers TeardownStarted; rotate validates; device removal 204 then 404", async () => {
    const w = await ready();
    expect((await send(w, "POST", "/v1/admin/machines/00000000-0000-4000-8000-000000000101/rotate", { kill: true })).status).toBe(400);
    expect((await send(w, "POST", "/v1/admin/machines/00000000-0000-4000-8000-000000000101/rotate", { kill_connections: false })).status).toBe(202);
    const del = await send(w, "DELETE", "/v1/admin/machines/00000000-0000-4000-8000-000000000101", undefined, { Origin: CP });
    expect(del.status).toBe(202);
    expect(validate("TeardownStarted", await del.json()).valid).toBe(true);
    expect((await send(w, "DELETE", "/v1/admin/devices/00000000-0000-4000-8000-000000000201", undefined, { Origin: CP })).status).toBe(204);
    expect((await send(w, "DELETE", "/v1/admin/devices/00000000-0000-4000-8000-000000000201", undefined, { Origin: CP })).status).toBe(404);
  });
  test("limit outside 1..100 is validation_failed", async () => {
    const w = await ready();
    expect((await send(w, "GET", "/v1/admin/users?limit=101", undefined, {})).status).toBe(400);
  });
});

test("rows are unique per method and path", () => {
  const keys = PHASE07_ROUTES.map((r: RouteRow) => `${r.method} ${r.path}`);
  expect(new Set(keys).size).toBe(keys.length);
});
