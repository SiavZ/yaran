/**
 * Session revocation through Access revoke_user.
 *
 * The recorded request shape and the dashboard-path fallback when Cloudflare refuses.
 *
 * <module-headers:begin>
 * Uses:
 * test/sessions/revoke-sessions.test.ts
 * ├── src/http/responses.ts
 * ├── src/sessions/revoke-sessions.ts
 * ├── test/phase06/fakes.ts
 * └── test/provisioning/fake-cloudflare/faults.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/http/responses.ts";
import { DASHBOARD_FALLBACK, revokeSessions } from "../../src/sessions/revoke-sessions.ts";
import { makeWorld } from "../phase06/fakes.ts";
import { on } from "../provisioning/fake-cloudflare/faults.ts";

const actor = { kind: "user" as const, id: "u1" };

describe("revokeSessions", () => {
  it("calls revoke_user with the email and audits sessions.revoked", async () => {
    const w = await makeWorld();
    await revokeSessions(w.ctx, { email: "ada@example.org", userId: "u1", actor });
    expect(w.cf.calls.map((c) => [c.method, c.path, c.body])).toEqual([["POST", "/accounts/acc123/access/organizations/revoke_user", { email: "ada@example.org" }]]);
    await w.refresh();
    expect(w.audit).toEqual([{ action: "sessions.revoked", actor, target: { kind: "user", id: "u1" }, outcome: "ok" }]);
  });

  it("names the dashboard path when Cloudflare refuses, and audits nothing", async () => {
    const w = await makeWorld();
    w.cf.faults.push({ kind: "forbidden", when: on("POST", /revoke_user$/) });
    const err = await revokeSessions(w.ctx, { email: "ada@example.org", userId: "u1", actor }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).code).toBe("cloudflare_permission_denied");
    expect((err as HttpError).message).toContain(DASHBOARD_FALLBACK);
    expect((err as HttpError).message).toContain("Zero Trust → Users → the person → Revoke sessions");
    await w.refresh();
    expect(w.audit).toEqual([]);
  });
});
