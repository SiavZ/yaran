/**
 * Host guard: open versus closed setup, crossed with the control-plane host, a
 * `*.workers.dev` host and any other Host.
 *
 * <module-headers:begin>
 * Uses:
 * test/host-guard.test.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { closeSetup, CP_HOST, openSetup } from "./helpers/seed.ts";
import { errorCode, handler } from "./helpers/worker.ts";

const call = handler();
const WORKERS_DEV = "yaran-cloud.acme.workers.dev";
const get = (host: string, path: string) => call(new Request(`https://${host}${path}`, { headers: { "Yaran-Protocol": "1" } }));

describe("setup open", () => {
  it("serves /v1/meta on any Host, the wizard on workers.dev only, and refuses everything else with 503 setup_incomplete", async () => {
    await closeSetup();
    await openSetup();
    expect((await get(WORKERS_DEV, "/setup")).status).toBe(200);
    for (const host of [CP_HOST, "other.example.org"]) expect(await errorCode(await get(host, "/setup"))).toBe("setup_incomplete");
    // The admin claim arrives on the control-plane host, behind the Access app setup created.
    expect(await errorCode(await get(CP_HOST, "/setup/claim"))).not.toBe("setup_incomplete");
    expect(await errorCode(await get(WORKERS_DEV, "/setup/claim"))).not.toBe("setup_incomplete");
    for (const host of [WORKERS_DEV, CP_HOST, "other.example.org"]) {
      expect((await get(host, "/v1/meta")).status).toBe(200);
      for (const path of ["/v1/me", "/v1/admin/audit", "/v1/machine/config"]) {
        const res = await get(host, path);
        expect(res.status).toBe(503);
        expect(await errorCode(res)).toBe("setup_incomplete");
        expect(res.headers.get("Retry-After")).not.toBeNull();
      }
    }
  });
});

describe("setup closed", () => {
  it("answers 421 misdirected_host to every other Host without naming a host", async () => {
    await closeSetup();
    for (const host of [WORKERS_DEV, "other.example.org", "CP.example.com.evil.test"]) {
      for (const path of ["/v1/meta", "/setup", "/v1/me", "/v1/machine/config"]) {
        const res = await get(host, path);
        expect(res.status).toBe(421);
        const text = await res.text();
        expect(text).toContain("misdirected_host");
        expect(text).not.toContain(CP_HOST);
        expect(text).not.toContain(host);
      }
    }
  });
  it("answers 410 setup_closed to /setup* on the control-plane host and still serves /v1/meta", async () => {
    await closeSetup();
    const res = await get(CP_HOST, "/setup");
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe("setup_closed");
    expect((await get(CP_HOST, "/v1/meta")).status).toBe(200);
    expect((await get("CP.EXAMPLE.COM", "/v1/meta")).status).toBe(200);
  });
});
