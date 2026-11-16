/**
 * The source installer's wizard driver against the real setup routes: it walks every step
 * through the same guards a browser meets, stops with an actionable message where a
 * person must act, and never sends the API token. Every request comes from one fixed
 * address, the rate limits run on the world's clock (the strict D1 counters, with the
 * real-time rate-limit bindings removed), and the driver's waits advance that clock, so
 * the route and setup-code limits really apply.
 *
 * <module-headers:begin>
 * Uses:
 * test/setup-installer.test.ts
 * ├── scripts/org-setup/wizard.ts
 * ├── src/admin/settings-store.ts
 * ├── src/setup/routes.ts
 * ├── src/setup/steps/common.ts
 * └── test/helpers/deps.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, test } from "vitest";
import { readKey } from "../src/admin/settings-store.ts";
import { loadRecord } from "../src/setup/steps/common.ts";
import { SETUP_ROUTES } from "../src/setup/routes.ts";
import { CODE_RETRY_MS, driveWizard, SetupStop, type WizardInput } from "../scripts/org-setup/wizard.ts";
import { closedOrg, dispatch, SETUP_CODE, world, type TestWorld } from "./helpers/deps.ts";

const WD = "https://yaran-cloud.acme.workers.dev";
const INPUT: WizardInput = {
  origin: WD,
  setupCode: SETUP_CODE,
  accountId: "acc1",
  adminEmail: "ada@example.org",
  zoneId: "z1",
  zoneName: "example.org",
  label: "cp",
  team: "example",
  addOneTimePin: true,
};

const ADDRESS = "198.51.100.7";

function io(w: TestWorld, onSleep: (ms: number) => void = () => {}) {
  w.env = { ...w.env, RL_IP: undefined, RL_AUTH: undefined } as unknown as TestWorld["env"];
  const sent: string[] = [];
  const paths: string[] = [];
  const statuses: number[] = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(String(init?.body ?? ""));
    paths.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
    const headers = new Headers(init?.headers);
    headers.set("CF-Connecting-IP", ADDRESS);
    const res = await dispatch(SETUP_ROUTES, w, init?.method ?? "GET", String(input), { ...init, headers });
    statuses.push(res.status);
    return res;
  }) as typeof globalThis.fetch;
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    w.clock.now = new Date(w.clock.now.getTime() + ms);
    onSleep(ms);
  };
  return { sent, paths, statuses, sleeps, logs, io: { fetch, sleep, log: (l: string) => logs.push(l) } };
}

describe("the installer's wizard driver", () => {
  test("walks every step to the claim link, adding One-time PIN only because it was asked to", async () => {
    const w = await world();
    const { io: wio, sent } = io(w);
    const out = await driveWizard(wio, INPUT);
    expect(out.kind).toBe("claim");
    expect(out.kind === "claim" && out.link).toMatch(/^https:\/\/cp\.example\.org\/setup\/claim\?c=[\w%-]+$/);
    const r = await loadRecord(w.db);
    expect(r.step).toBe("claim");
    expect(r.admin_email).toBe("ada@example.org");
    expect(w.cf.idps.some((p) => p.type === "onetimepin")).toBe(true);
    // Access exists before the hostname is attached, as in the browser flow.
    expect(w.cf.calls.indexOf("POST /accounts/acc1/access/apps")).toBeLessThan(w.cf.calls.indexOf("PUT /accounts/acc1/workers/domains"));
    expect(await readKey(w.db, "setup_state")).toBeUndefined();
    expect(sent.join("\n")).not.toContain(w.env.CF_API_TOKEN);
  });

  test("resumes where the record left off", async () => {
    const w = await world();
    await driveWizard(io(w).io, INPUT);
    const again = await driveWizard(io(w).io, INPUT);
    expect(again.kind).toBe("claim");
    expect(w.cf.calls.filter((c) => c === "PUT /accounts/acc1/workers/domains")).toHaveLength(1);
  });

  test("does not add a sign-in method on its own", async () => {
    const w = await world();
    const err = await driveWizard(io(w).io, { ...INPUT, addOneTimePin: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupStop);
    expect((err as Error).message).toContain("--one-time-pin");
    expect((await loadRecord(w.db)).step).toBe("idp");
    expect(w.cf.idps.some((p) => p.type === "onetimepin")).toBe(false);
  });

  test("a token missing a permission stops at the token step, naming it and the template", async () => {
    const w = await world();
    w.cf.fault("GET /accounts/acc1/access/identity_providers", "auth");
    const err = await driveWizard(io(w).io, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupStop);
    expect((err as Error).message).toContain("Access: Organizations, Identity Providers, and Groups Edit");
    expect((err as Error).message).toContain("dash.cloudflare.com");
    expect((err as Error).message).not.toContain(w.env.CF_API_TOKEN);
    expect(await readKey(w.db, "cf_api_token_enc")).toBeUndefined();
  });

  test("a token that sees no account is retried with the account id, then reported as unverifiable", async () => {
    const w = await world();
    w.cf.fault("GET /accounts/acc1/tokens/verify", "auth").fault("GET /accounts", "auth");
    const err = await driveWizard(io(w).io, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SetupStop);
    expect((err as Error).message).toContain("could not be verified against account acc1");
    expect((err as Error).message).toContain("--token");
    expect(w.cf.calls).toContain("GET /accounts/acc1/tokens/verify");
    expect((await loadRecord(w.db)).step).toBe("token");
  });

  test("a closed org is reported, not touched", async () => {
    const w = await world();
    await closedOrg(w);
    expect(await driveWizard(io(w).io, INPUT)).toEqual({ kind: "closed" });
    expect(w.cf.calls).toHaveLength(0);
  });

  test("a wrong setup code is refused by the gate and reported", async () => {
    const w = await world();
    const err = await driveWizard(io(w).io, { ...INPUT, setupCode: "x".repeat(32) }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("refused the saved setup code");
    expect((await loadRecord(w.db)).step).toBe("locked");
  });

  test("one address walking the whole wizard is paced by the route limit and waits it out", async () => {
    const w = await world();
    const t = io(w);
    expect((await driveWizard(t.io, INPUT)).kind).toBe("claim");
    expect(t.statuses).toContain(429);
    expect(t.logs.some((l) => l.startsWith("Setup is pacing requests"))).toBe(true);
    expect(t.sleeps.every((ms) => ms <= 60_000)).toBe(true);
  });

  test("a just-uploaded code the edge has not picked up yet is tried exactly once more, after a wait", async () => {
    const w = await world();
    const fresh = "n".repeat(32);
    const t = io(w, (ms) => {
      if (ms === CODE_RETRY_MS) (w.env as { SETUP_CODE: string }).SETUP_CODE = fresh;
    });
    expect((await driveWizard(t.io, { ...INPUT, setupCode: fresh, codeJustSet: true })).kind).toBe("claim");
    expect(t.paths.filter((x) => x === "POST /setup/code")).toHaveLength(2);
  });

  test("a code that stays wrong is not tried a third time", async () => {
    const w = await world();
    const t = io(w);
    const err = await driveWizard(t.io, { ...INPUT, setupCode: "x".repeat(32), codeJustSet: true }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("refused the saved setup code");
    expect(t.paths.filter((x) => x === "POST /setup/code")).toHaveLength(2);
    expect(t.sleeps).toEqual([CODE_RETRY_MS]);
  });
});
