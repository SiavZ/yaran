/**
 * The setup code gate: secret checks, constant-time comparison, per-address lockout and
 * unlock, cookie.
 *
 * <module-headers:begin>
 * Uses:
 * test/setup-gate.test.ts
 * ├── src/setup/setup-gate.ts
 * └── test/helpers/deps.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { checkSetupCode, compare, hasSetupSession, issueSetupCookie, lockReason, secretProblems } from "../src/setup/setup-gate.ts";
import { env } from "cloudflare:test";
import { wipe } from "./helpers/deps.ts";

beforeEach(wipe);

const CODE = "a-long-random-setup-code-123456";
const NOW = new Date("2026-11-14T12:00:00Z");
const valid = (k: string) => k.length >= 43;

describe("secrets", () => {
  test.each([
    [{}, ["setup_code_missing", "data_key_missing"]],
    [{ SETUP_CODE: "short", DATA_KEY: "x" }, ["setup_code_short", "data_key_malformed"]],
    [{ SETUP_CODE: CODE, DATA_KEY: "k".repeat(64) }, []],
  ])("%o → %o", (env, problems) => expect(secretProblems(env, valid)).toEqual(problems));
});

describe("code check", () => {
  const IP = "198.51.100.1";
  const NOW_S = Math.floor(NOW.getTime() / 1000);

  test("uses the constant-time comparison", async () => {
    const spy = vi.spyOn(compare, "equal");
    expect(await checkSetupCode(env.DB, CODE, CODE, IP, NOW_S)).toEqual({ kind: "ok" });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  test("locks the address after 20 wrong codes, even for the right code, and only that address", async () => {
    const db = env.DB;
    for (let i = 1; i < 20; i++) expect(await checkSetupCode(db, `wrong-${i}`, CODE, IP, NOW_S)).toEqual({ kind: "setup_code_invalid" });
    expect(await checkSetupCode(db, "wrong-20", CODE, IP, NOW_S)).toEqual({ kind: "setup_locked", reason: "failures" });
    expect(await lockReason(db, CODE, IP)).toBe("failures");
    expect(await lockReason(db, CODE, "198.51.100.2")).toBeNull();
    expect(await checkSetupCode(db, CODE, CODE, "198.51.100.2", NOW_S)).toEqual({ kind: "ok" });
  });

  test("changing SETUP_CODE unlocks and resets the counter", async () => {
    const db = env.DB;
    for (let i = 0; i < 20; i++) await checkSetupCode(db, `wrong-${i}`, CODE, IP, NOW_S);
    const next = `${CODE}-rotated`;
    expect(await lockReason(db, next, IP)).toBeNull();
    expect(await checkSetupCode(db, "nope", next, IP, NOW_S)).toEqual({ kind: "setup_code_invalid" });
    expect(await checkSetupCode(db, next, next, IP, NOW_S)).toEqual({ kind: "ok" });
  });
});

describe("setup cookie", () => {
  const req = (cookie: string) => new Request("https://x.workers.dev/setup", { headers: { Cookie: cookie } });
  const pair = (setCookie: string) => setCookie.split(";")[0]!;

  test("is __Host-, HttpOnly, Secure, SameSite=Strict, 30 minutes", async () => {
    const c = await issueSetupCookie(CODE, NOW);
    expect(c).toMatch(/^__Host-yaran-setup=\d+\.[\w-]+; Max-Age=1800; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  });

  test("is accepted until it expires, and only under the code that signed it", async () => {
    const c = pair(await issueSetupCookie(CODE, NOW));
    expect(await hasSetupSession(req(c), CODE, NOW)).toBe(true);
    expect(await hasSetupSession(req(c), CODE, new Date(NOW.getTime() + 31 * 60_000))).toBe(false);
    expect(await hasSetupSession(req(c), `${CODE}-other`, NOW)).toBe(false);
    expect(await hasSetupSession(req(c.replace(/\d+\./, (m) => `${Number(m.slice(0, -1)) + 9999}.`)), CODE, NOW)).toBe(false);
    expect(await hasSetupSession(req(""), CODE, NOW)).toBe(false);
  });
});
