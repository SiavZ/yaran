/**
 * Replays the whole authorization-matrix corpus with recognizable sentinel secrets and
 * asserts that none of them appears in any console line, response body or header.
 *
 * Sentinels: CF_API_TOKEN, DATA_KEY (and its decoded bytes as hex), SETUP_CODE, every JWT
 * and every machine signature the corpus sends, and a device push endpoint sealed in D1.
 *
 * <module-headers:begin>
 * Uses:
 * test/no-secret-leak.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/db/client.ts
 * ├── src/http/routes.ts
 * ├── src/security/data-key.ts
 * ├── test/helpers/app.ts
 * ├── test/helpers/matrix.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { toHex } from "@yaran/protocol";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { run } from "../src/db/client.ts";
import type { Route } from "../src/http/routes.ts";
import { resetKeyRingCache, seal } from "../src/security/data-key.ts";
import { appCtx } from "./helpers/app.ts";
import { HOSTS, IDENTITIES, matrixFixture, send, setSetupState, type Fixture, type HostKind } from "./helpers/matrix.ts";
import { NOW, seedUser } from "./helpers/seed.ts";
import { ALL_ROUTES, handler } from "./helpers/worker.ts";

const DATA_KEY_BYTES = new TextEncoder().encode("SENTINEL-DATA-KEY-32-BYTES-LONG!");
const SENTINEL_ENV = {
  CF_API_TOKEN: "SENTINEL-CF-API-TOKEN-7f3a",
  SETUP_CODE: "SENTINEL-SETUP-CODE-91c2",
  DATA_KEY: btoa(String.fromCharCode(...DATA_KEY_BYTES)),
};
const ENDPOINT = "https://push.example/SENTINEL-ENDPOINT-5d1e";

let f: Fixture;
const sentinels: string[] = [...Object.values(SENTINEL_ENV), toHex(DATA_KEY_BYTES), ENDPOINT];

beforeAll(async () => {
  f = await matrixFixture();
  sentinels.push(...Object.values(f.jwts));
  resetKeyRingCache();
  const u = await seedUser();
  const id = crypto.randomUUID();
  const sealed = await seal(appCtx(SENTINEL_ENV), "device_endpoint", { table: "devices", column: "endpoint_enc", rowId: id }, ENDPOINT);
  await run(env.DB,
    `INSERT INTO devices (id, user_id, install_id, platform, flavor, form_factor, push_kind, endpoint_enc, device_key, device_key_fingerprint, app_version, label, created_at)
     VALUES (?, ?, ?, 'android', 'foss', 'phone', 'unifiedpush', ?, ?, ?, '1.0.0', 'Phone', ?)`,
    id, u.id, crypto.randomUUID(), sealed, new Uint8Array(65), "A".repeat(29), NOW);
});

/** A probe that tries to log what a careless handler might. */
const careless: Route = {
  method: "POST", path: "/v1/machine/leaky", auth: { kind: "public" }, kind: "json", protocol: "none", rateLimit: "ip",
  handler: async (ctx) => {
    ctx.log.info("careless", { token: ctx.env.CF_API_TOKEN, endpoint: ENDPOINT, headers: { authorization: ctx.request.headers.get("Cf-Access-Jwt-Assertion") }, signature: ctx.request.headers.get("Yaran-Signature") });
    throw new Error("boom");
  },
};

describe("no secret leaks", () => {
  it("across the whole matrix corpus, before and after setup closes", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(capture));
    const leakEnv = { ...env, ...SENTINEL_ENV } as Cloudflare.Env;
    const surfaces: string[] = [];
    const recordResponse = async (res: Response) => surfaces.push(`${res.status} ${[...res.headers].join(";")} ${await res.text()}`);
    for (const setup of ["open", "closed"] as const) {
      await setSetupState(setup);
      for (const route of ALL_ROUTES) {
        for (const host of Object.keys(HOSTS) as HostKind[]) {
          for (const id of IDENTITIES) {
            await recordResponse(await send(f, route, id, host, leakEnv));
          }
        }
      }
    }
    await recordResponse(await handler({}, [careless])(new Request(`https://${HOSTS.control_plane}/v1/machine/leaky`, {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": f.jwts.admin, "Yaran-Signature": "S".repeat(86) },
    }), leakEnv));
    sentinels.push("S".repeat(86), ...f.signatures);
    expect(f.signatures.length).toBeGreaterThan(100);
    for (const s of spies) s.mockRestore();
    expect(lines.length).toBeGreaterThan(100);
    const haystack = `${lines.join("\n")}\n${surfaces.join("\n")}`;
    for (const sentinel of sentinels) expect(haystack.includes(sentinel), `leaked ${sentinel.slice(0, 24)}…`).toBe(false);
  });
});
