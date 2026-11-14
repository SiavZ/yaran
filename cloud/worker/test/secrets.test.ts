/**
 * Deploy-time secrets: validation, the 503 refusal with only /v1/meta answering, the log
 * line that names the secret (never its value), and the constant-time setup-code check.
 *
 * <module-headers:begin>
 * Uses:
 * test/secrets.test.ts
 * ├── src/security/secrets.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { decodeDataKey, secretProblems, setupCodeMatches } from "../src/security/secrets.ts";
import { closeSetup, CP_HOST, openSetup } from "./helpers/seed.ts";
import { errorCode, handler } from "./helpers/worker.ts";

const call = handler();

describe("validation", () => {
  it("accepts the test secrets and reports each missing or malformed one", () => {
    expect(secretProblems(env)).toEqual([]);
    // CF_API_TOKEN may be absent (setup keeps the token sealed in D1), never blank.
    expect(secretProblems({ ...env, CF_API_TOKEN: "", SETUP_CODE: "short", DATA_KEY: "!!!" })).toEqual([
      { name: "SETUP_CODE", problem: "malformed" },
      { name: "DATA_KEY", problem: "malformed" },
    ]);
    expect(secretProblems({ ...env, CF_API_TOKEN: "   " })).toEqual([{ name: "CF_API_TOKEN", problem: "malformed" }]);
    expect(decodeDataKey(btoa("x".repeat(31)))).toBeNull();
    expect(decodeDataKey(btoa("x".repeat(32)))?.length).toBe(32);
    expect(decodeDataKey("a".repeat(64))?.length).toBe(48);
  });
});

describe("refusal", () => {
  beforeAll(() => closeSetup());
  // The last row repeats a (secret, problem) pair: it is logged once per isolate, not per request.
  const variants: [string, Partial<Cloudflare.Env>, string, boolean][] = [
    ["missing SETUP_CODE", { SETUP_CODE: undefined }, "SETUP_CODE", true],
    ["missing DATA_KEY", { DATA_KEY: undefined }, "DATA_KEY", true],
    ["short DATA_KEY", { DATA_KEY: btoa("short") }, "DATA_KEY", true],
    ["invalid DATA_KEY", { DATA_KEY: "not base64 !!" }, "DATA_KEY", false],
  ];
  it.each(variants)("%s: 503 unavailable for everything but /v1/meta, and a log line naming the secret", async (_n, patch, name, logs) => {
    const spy = vi.spyOn(console, "log");
    const broken = { ...env, ...patch } as Cloudflare.Env;
    const res = await call(new Request(`https://${CP_HOST}/v1/me`, { headers: { "Yaran-Protocol": "1" } }), broken);
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe("unavailable");
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect((await call(new Request(`https://${CP_HOST}/v1/meta`), broken)).status).toBe(200);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"secret_unusable"') && l.includes(`"${name}"`))).toBe(logs);
    for (const value of Object.values(patch)) if (value) expect(lines.join("\n")).not.toContain(value);
    spy.mockRestore();
  });
  it("lets the setup wizard explain a missing SETUP_CODE itself, and does nothing else", async () => {
    await openSetup();
    const res = await call(new Request("https://yaran-cloud.acme.workers.dev/setup"), { ...env, SETUP_CODE: undefined } as Cloudflare.Env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("SETUP_CODE");
    await closeSetup();
  });
});

describe("setupCodeMatches", () => {
  it("matches only the exact code, hashing both sides whatever their length", async () => {
    const spy = vi.spyOn(crypto.subtle, "timingSafeEqual");
    expect(await setupCodeMatches(env, env.SETUP_CODE!)).toBe(true);
    expect(await setupCodeMatches(env, `${env.SETUP_CODE!}x`)).toBe(false);
    expect(await setupCodeMatches(env, "")).toBe(false);
    expect(await setupCodeMatches(env, "x".repeat(10_000))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) expect([(call[0] as ArrayBuffer).byteLength, (call[1] as ArrayBuffer).byteLength]).toEqual([32, 32]);
    spy.mockRestore();
    expect(await setupCodeMatches({ ...env, SETUP_CODE: "short" } as Cloudflare.Env, "short")).toBe(false);
  });
});
