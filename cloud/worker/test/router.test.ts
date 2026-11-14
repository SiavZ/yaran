/**
 * Router and canonical-path tests, including Gate G8's normalization probe set.
 *
 * <module-headers:begin>
 * Uses:
 * test/router.test.ts
 * ├── src/http/router.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { beforeAll, describe, expect, it } from "vitest";
import { compileRoutes, isCanonicalPath } from "../src/http/router.ts";
import { closeSetup, CP_HOST } from "./helpers/seed.ts";
import { errorCode, handler, PROBE_ROUTES } from "./helpers/worker.ts";

const G8_PROBES = ["/v1/MACHINE/claim", "/v1/machine/%2e%2e/me", "/v1/machine/a/b", "//v1/me", "/v1/machine/a%2fb", "/v1/me/%2E", "/v1/Me"];

describe("isCanonicalPath", () => {
  it.each(G8_PROBES.filter((p) => p !== "/v1/machine/a/b"))("refuses %s", (p) => expect(isCanonicalPath(p)).toBe(false));
  it.each(["/v1/machine/claim", "/v1/machine/unpair", "/v1/machine/origin", "/v1/me/devices/x", "/setup", "/"])("accepts %s", (p) =>
    expect(isCanonicalPath(p)).toBe(true));
  it("refuses malformed percent-encoding and backslashes", () => {
    expect(isCanonicalPath("/v1/me/%zz")).toBe(false);
    expect(isCanonicalPath("/v1/me\\x")).toBe(false);
  });
});

describe("compileRoutes", () => {
  const router = compileRoutes(PROBE_ROUTES);
  it("distinguishes 404 from 405 and extracts params", () => {
    expect(router.match("GET", "/nope").kind).toBe("not_found");
    const m405 = router.match("PATCH", "/v1/me/devices/abc");
    expect(m405).toEqual({ kind: "method_not_allowed", allow: ["DELETE"] });
    const hit = router.match("DELETE", "/v1/me/devices/abc");
    expect(hit.kind === "route" && hit.params).toEqual({ id: "abc" });
  });
  it("has no trailing-slash ambiguity", () => {
    expect(router.match("GET", "/v1/me/").kind).toBe("not_found");
  });
  it("refuses a duplicate route", () => {
    expect(() => compileRoutes([PROBE_ROUTES[0]!, PROBE_ROUTES[0]!])).toThrow(/duplicate/);
  });
});

describe("G8 probes through the pipeline", () => {
  beforeAll(() => closeSetup());
  const call = handler();
  it("documents that the runtime URL parser resolves %2e%2e before the Worker sees it", () => {
    expect(new URL(`https://${CP_HOST}/v1/machine/%2e%2e/me`).pathname).toBe("/v1/me");
  });
  it.each(G8_PROBES)("%s is 404 or never reaches a machine route", async (p) => {
    const res = await call(new Request(`https://${CP_HOST}${p}`, { method: "POST" }));
    // The URL parser resolves %2e%2e before the Worker sees it (G8); what is left must not
    // reach a machine handler, and anything non-canonical is a plain 404.
    expect([404, 401, 405]).toContain(res.status);
    if (res.status !== 404) expect(new URL(`https://${CP_HOST}${p}`).pathname.startsWith("/v1/machine/")).toBe(false);
    expect(await errorCode(res)).not.toBe("signature_missing");
  });
  it("routes the canonical machine paths to the signature check", async () => {
    for (const [method, p] of [["POST", "/v1/machine/claim"], ["POST", "/v1/machine/unpair"], ["PUT", "/v1/machine/origin"]] as const) {
      const res = await call(new Request(`https://${CP_HOST}${p}`, { method, headers: { "Yaran-Protocol": "1" } }));
      expect(await errorCode(res)).toBe("signature_missing");
    }
  });
  it("answers 405 with Allow", async () => {
    const res = await call(new Request(`https://${CP_HOST}/v1/me/devices/x`, { method: "PATCH" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("DELETE");
  });
});
