/**
 * W10 and W11: the caller's machine list and unpairing one.
 *
 * Ownership answers 404, revoked machines stay hidden, pages are stable, and a list never calls Cloudflare.
 *
 * <module-headers:begin>
 * Uses:
 * test/me/machines-route.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { validate } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { CP_HOST, fakeJwt, machineRow, makeWorld, opsOf, seedMachine, seedUser, type SeededUser } from "../phase06/fakes.ts";
import { CP_AUD, dispatch } from "../phase06/harness.ts";

// Storage is shared across the tests of one file, so every user gets a fresh email.
const email = (n: string) => `${n}-${crypto.randomUUID().slice(0, 8)}@example.org`;
const req = (u: SeededUser, path: string, method = "GET") =>
  new Request(`https://${CP_HOST}${path}`, { method, headers: { "Cf-Access-Jwt-Assertion": fakeJwt({ email: u.email, sub: u.id, exp: 1_900_000_000, aud: [CP_AUD] }) } });

describe("W10 GET /v1/me/machines", () => {
  it("lists only the caller's non-revoked machines, from D1 alone", async () => {
    const w = await makeWorld();
    const ada = await seedUser(w.ctx.db, email("ada"));
    const bob = await seedUser(w.ctx.db, email("bob"));
    const mine = await seedMachine(w.ctx.db, ada, { cfStatus: "healthy" });
    await seedMachine(w.ctx.db, ada, { name: "old", status: "revoked" });
    await seedMachine(w.ctx.db, bob);
    const res = await dispatch(req(ada, "/v1/me/machines"), w);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const page = (await res.json()) as { items: { id: string; status: string }[]; next_cursor: string | null };
    expect(validate("MachinePage", page).errors).toEqual([]);
    expect(page.items.map((m) => [m.id, m.status])).toEqual([[mine, "online"]]);
    expect(page.next_cursor).toBeNull();
    expect(w.cf.calls).toEqual([]);
  });

  it("pages with an opaque cursor and refuses a forged one", async () => {
    const w = await makeWorld();
    const ada = await seedUser(w.ctx.db, email("ada"));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await seedMachine(w.ctx.db, ada, { name: `m${i}` }));
    const p1 = (await (await dispatch(req(ada, "/v1/me/machines?limit=2"), w)).json()) as { items: { id: string }[]; next_cursor: string };
    expect(p1.items).toHaveLength(2);
    const p2 = (await (await dispatch(req(ada, `/v1/me/machines?limit=2&cursor=${p1.next_cursor}`), w)).json()) as { items: { id: string }[]; next_cursor: null };
    expect([...p1.items, ...p2.items].map((m) => m.id).sort()).toEqual(ids.sort());
    expect(p2.next_cursor).toBeNull();
    expect((await dispatch(req(ada, "/v1/me/machines?cursor=bm9wZQ"), w)).status).toBe(400);
    expect((await dispatch(req(ada, "/v1/me/machines?limit=101"), w)).status).toBe(400);
  });
});

describe("W11 DELETE /v1/me/machines/{id}", () => {
  it("tears down the caller's machine with 202 and audits it", async () => {
    const w = await makeWorld();
    const ada = await seedUser(w.ctx.db, email("ada"));
    const id = await seedMachine(w.ctx.db, ada);
    // Cloudflare keeps failing transiently, so the teardown stays in progress.
    w.cf.faults.push({ kind: "transient", when: () => true, times: 100 });
    const res = await dispatch(req(ada, `/v1/me/machines/${id}`, "DELETE"), w);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(validate("TeardownStarted", body).errors).toEqual([]);
    expect(body).toEqual({ machine_id: id, state: "tearing_down" });
    expect((await opsOf(w, id)).map((o) => o.kind)).toEqual(["teardown"]);
    expect(await machineRow(w, id)).toMatchObject({ revoke_reason: "user_unpair" });
    expect(w.audit.filter((a) => a.action === "machine.unpaired").map((a) => [a.action, a.actor.kind, a.target.id])).toEqual([["machine.unpaired", "user", id]]);
    // A retry while tearing down answers 202 again with no second teardown.
    expect((await dispatch(req(ada, `/v1/me/machines/${id}`, "DELETE"), w)).status).toBe(202);
    expect(await opsOf(w, id)).toHaveLength(1);
  });

  it("answers 404 for another user's machine and a revoked one", async () => {
    const w = await makeWorld();
    const ada = await seedUser(w.ctx.db, email("ada"));
    const bob = await seedUser(w.ctx.db, email("bob"));
    const bobs = await seedMachine(w.ctx.db, bob);
    const gone = await seedMachine(w.ctx.db, ada, { status: "revoked" });
    for (const id of [bobs, gone, crypto.randomUUID()]) {
      const res = await dispatch(req(ada, `/v1/me/machines/${id}`, "DELETE"), w);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }
    expect(w.cf.calls).toEqual([]);
  });
});
