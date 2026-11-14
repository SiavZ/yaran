/**
 * The release train helpers and the daily update check: manifest fixtures, SemVer order,
 * raw manifest first with the API as fallback, the 24 h gate, and never "up to date" on error.
 *
 * <module-headers:begin>
 * Uses:
 * test/update-checker.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── cloud/protocol/fixtures/api/ReleaseManifest.json
 * ├── src/update/release-manifest.ts
 * ├── src/update/update-checker.ts
 * └── test/helpers/deps.ts
 * External: cloudflare:test, vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { beforeEach, describe, expect, test } from "vitest";
import fixtures from "@yaran/protocol/fixtures/api/ReleaseManifest.json" with { type: "json" };
import { compareSemver, newestTrainRelease, parseManifest, RAW_MANIFEST_URL, RELEASES_API_URL } from "../src/update/release-manifest.ts";
import { checkForUpdate, maybeCheckForUpdate, readUpdateStatus } from "../src/update/update-checker.ts";
import { validate } from "@yaran/protocol";
import { env } from "cloudflare:test";
import { wipe } from "./helpers/deps.ts";

beforeEach(wipe);

export const MANIFEST = fixtures.valid[0]!.value;

describe("release manifest", () => {
  test.each(fixtures.valid.map((c) => [c.name, c.value]))("valid %s", (_n, v) => expect(parseManifest(v).ok).toBe(true));
  test.each(fixtures.invalid.map((c) => [c.name, c.value]))("invalid %s", (_n, v) => expect(parseManifest(v).ok).toBe(false));
  test("a bad semver and a missing field are refused", () => {
    expect(parseManifest({ ...MANIFEST, version: "1.2" }).ok).toBe(false);
    const { tarball: _t, ...missing } = MANIFEST;
    expect(parseManifest(missing).ok).toBe(false);
  });
  test.each([
    ["1.2.0", "1.10.0", -1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0-rc.1", "1.0.0", -1],
    ["1.0.0", "1.0.0", 0],
  ])("%s vs %s", (a, b, sign) => expect(Math.sign(compareSemver(a, b))).toBe(sign));
  test("the newest release is picked from the yaran-cloud train only, by SemVer", () => {
    const r = (tag: string, extra = {}) => ({ tag_name: tag, html_url: `https://x/${tag}`, ...extra });
    expect(newestTrainRelease([r("yaran-v9.0.0"), r("yaran-cloud-v1.9.0"), r("yaran-cloud-v1.10.0"), r("yaran-cloud-v2.0.0", { prerelease: true })])?.version).toBe("1.10.0");
  });
});

function fetcher(routes: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`network down for ${url}`);
    return r();
  }) as typeof fetch;
}

const deps = (f: typeof fetch, now = new Date("2026-11-14T12:00:00Z")) => ({ db: env.DB, fetch: f, now: () => now, workerVersion: "1.0.0" });

describe("update checker", () => {
  test("prefers the raw manifest", async () => {
    const seen: string[] = [];
    const s = await checkForUpdate(deps(fetcher({ [RAW_MANIFEST_URL]: () => Response.json({ ...MANIFEST, security: true }) }, seen)));
    expect(s).toMatchObject({ current: "1.0.0", latest: "1.2.0", update_available: true, security: true, error: null });
    expect(validate("UpdateStatus", s).valid).toBe(true);
    expect(seen).toEqual([RAW_MANIFEST_URL]);
  });
  test("falls back to the releases API filtered to the train", async () => {
    const s = await checkForUpdate(
      deps(
        fetcher({
          [RAW_MANIFEST_URL]: () => new Response("rate limited", { status: 429 }),
          [RELEASES_API_URL]: () => Response.json([{ tag_name: "yaran-v5.0.0", html_url: "x" }, { tag_name: "yaran-cloud-v1.1.0", html_url: "https://github.com/SiavZ/yaran/releases/tag/yaran-cloud-v1.1.0" }]),
        }),
      ),
    );
    expect(s).toMatchObject({ latest: "1.1.0", update_available: true, security: false, error: null });
  });
  test("a failure is stored as an error with the last known latest, never as up to date", async () => {
    const d = deps(fetcher({ [RAW_MANIFEST_URL]: () => Response.json(MANIFEST) }));
    await checkForUpdate(d);
    d.fetch = fetcher({});
    const s = await checkForUpdate(d);
    expect(s.error).toMatch(/network down/);
    expect(s).toMatchObject({ latest: "1.2.0", update_available: true });
    await wipe(); // a fresh database
    const fresh = await readUpdateStatus(deps(fetcher({})));
    expect(fresh).toMatchObject({ latest: null, update_available: false, error: "not checked yet" });
  });
  test("an invalid manifest is an error, not a version", async () => {
    const s = await checkForUpdate(deps(fetcher({ [RAW_MANIFEST_URL]: () => Response.json({ ...MANIFEST, version: "x" }), [RELEASES_API_URL]: () => Response.json([]) })));
    expect(s.error).toMatch(/invalid/);
    expect(s.update_available).toBe(false);
  });
  test("checks at most once a day (injected clock)", async () => {
    const seen: string[] = [];
    let now = new Date("2026-11-14T12:00:00Z");
    const d = { db: env.DB, fetch: fetcher({ [RAW_MANIFEST_URL]: () => Response.json(MANIFEST) }, seen), now: () => now, workerVersion: "1.0.0" };
    expect(await maybeCheckForUpdate(d)).not.toBeNull();
    now = new Date("2026-11-15T11:59:00Z");
    expect(await maybeCheckForUpdate(d)).toBeNull();
    now = new Date("2026-11-15T12:00:01Z");
    expect(await maybeCheckForUpdate(d)).not.toBeNull();
    expect(seen).toHaveLength(2);
  });
});
