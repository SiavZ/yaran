/**
 * `GET /v1/meta`: schema-valid `Meta` before and after setup, cacheable, and carrying
 * exactly the documented fields and nothing else.
 *
 * <module-headers:begin>
 * Uses:
 * test/me/meta.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/routes/meta.ts
 * ├── test/phase06/fakes.ts
 * └── test/phase06/harness.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { validate, type Meta } from "@yaran/protocol";
import { describe, expect, it } from "vitest";
import { META_ROUTES } from "../../src/routes/meta.ts";
import { CP_HOST, makeWorld, TEAM } from "../phase06/fakes.ts";
import { dispatch } from "../phase06/harness.ts";

async function meta(setupState: "open" | "closed", pushEnabled = true): Promise<{ res: Response; body: Meta }> {
  const w = await makeWorld();
  w.internal.setupState = setupState;
  w.settings.push.enabled = pushEnabled;
  const res = await dispatch(META_ROUTES, new Request(`https://${CP_HOST}/v1/meta`), w.ctx);
  return { res, body: (await res.json()) as Meta };
}

describe("GET /v1/meta", () => {
  it("before setup says only what the service is", async () => {
    const { res, body } = await meta("open");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(validate("Meta", body).valid).toBe(true);
    expect(body).toEqual({ service: "yaran-cloud", protocol: { min: 1, max: 1 }, setup: "open", worker: { version: "1.0.0" } });
  });

  it("after setup adds org, access, capabilities and push, and nothing else", async () => {
    const { body } = await meta("closed");
    expect(validate("Meta", body).valid).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["access", "capabilities", "org", "protocol", "push", "service", "setup", "worker"]);
    expect(body.org).toEqual({ name: "Example Org", url: `https://${CP_HOST}` });
    expect(body.access).toEqual({ team_domain: TEAM });
    expect(body.capabilities).toContain("handoff.v1");
    expect(body.push).toEqual({ enabled: true, vapid_public_key: expect.stringMatching(/^B[A-Za-z0-9_-]{86}$/) });
  });

  it("serves a null VAPID key while push is off", async () => {
    const { body } = await meta("closed", false);
    expect(validate("Meta", body).valid).toBe(true);
    expect(body.push).toEqual({ enabled: false, vapid_public_key: null });
  });
});
