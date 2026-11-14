/**
 * Keeps the fake Cloudflare honest: every fixture in `fixtures/cfapi/` (derived now, recorded
 * by `scripts/record-cf-fixtures.mjs` in 03/19) and the fake's answer to the same request both
 * carry every field the engine reads, with the same JSON type and HTTP status.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/fixture-contract.test.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/provisioning/helpers/world.ts
 * External: node:fs, node:path, node:url, vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp, createPolicy } from "../../src/cloudflare/access.ts";
import { createDnsRecord } from "../../src/cloudflare/dns.ts";
import { createTunnel } from "../../src/cloudflare/tunnels.ts";
import { FAKE_BASE } from "./fake-cloudflare/index.ts";
import { makeWorld } from "./helpers/world.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures/cfapi");

/** Paths (dot, `[]` for array items) the engine reads from each response. */
const READS: Record<string, string[]> = {
  "tunnel-create": ["success", "result.id", "result.name"],
  "tunnel-list": ["result[].id", "result[].name", "result[].status", "result[].conns_active_at", "result[].conns_inactive_at", "result[].deleted_at", "result_info.total_count"],
  "tunnel-token": ["result"],
  "tunnel-config-put": ["result.version"],
  "dns-create": ["result.id"],
  "dns-list": ["result[].id", "result[].type", "result[].name", "result[].content", "result[].proxied", "result[].ttl", "result[].comment", "result_info.total_count"],
  "access-app-create": ["result.id", "result.aud"],
  "access-app-list": ["result[].id", "result[].aud", "result[].name", "result[].domain", "result_info.total_count"],
  "access-policy-create": ["result.id"],
  "access-policy-list": ["result[].id", "result[].name", "result[].app_count", "result_info.total_count"],
  "error-tunnel-name-conflict": ["success", "errors[].code", "errors[].message"],
  "error-dns-same-name": ["success", "errors[].code", "errors[].message"],
};

interface Fixture {
  source: "derived" | "recorded";
  request: { method: string; path: string; query?: Record<string, string>; body?: unknown };
  response: { status: number; body: unknown };
}

/** JSON types at a path; null is "absent value", which any type may hold. */
function typesAt(v: unknown, path: string): string[] {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return [];
  const isArr = head.endsWith("[]");
  const key = isArr ? head.slice(0, -2) : head;
  const next = (v as Record<string, unknown> | null)?.[key];
  const items = isArr ? (Array.isArray(next) ? next : []) : [next];
  return items.flatMap((x) => (rest.length ? typesAt(x, rest.join(".")) : x === undefined ? [] : [x === null ? "null" : Array.isArray(x) ? "array" : typeof x]));
}

describe("fixture contract", () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

  it("covers every fixture file with a READS entry", () => {
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(Object.keys(READS).sort());
  });

  for (const file of files) {
    const name = file.replace(/\.json$/, "");
    it(name, async () => {
      const fx = JSON.parse(readFileSync(join(DIR, file), "utf8")) as Fixture;
      expect(["derived", "recorded"]).toContain(fx.source);
      const w = makeWorld();
      const t = await createTunnel(w.ctx.cf, "acct-1", "yaran-a1b2c3d4-seed", "interactive");
      const p = await createPolicy(w.ctx.cf, "acct-1", { name: "yaran:a1b2c3d4:owner:x", decision: "allow", include: [] }, "interactive");
      await createApp(w.ctx.cf, "acct-1", { name: "yaran:a1b2c3d4:m:x", domain: "laptop-alice.example.com", policies: [{ id: p.id, precedence: 1 }] }, "interactive");
      const r = await createDnsRecord(w.ctx.cf, "zone-1", { type: "CNAME", name: "laptop-alice.example.com", content: `${t.id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: "c" }, "interactive");
      const fill = (s: string) =>
        s
          .replaceAll("{account}", "acct-1")
          .replaceAll("{zone}", "zone-1")
          .replaceAll("{tunnel_id}", t.id)
          .replaceAll("{tunnel_name}", t.name)
          .replaceAll("{policy_id}", p.id)
          .replaceAll("{record_name}", r.name);
      const url = new URL(FAKE_BASE + fill(fx.request.path));
      for (const [k, v] of Object.entries(fx.request.query ?? {})) url.searchParams.set(k, v);
      const init: RequestInit = { method: fx.request.method };
      if (fx.request.body !== undefined) init.body = fill(JSON.stringify(fx.request.body));
      const res = await w.cf.fetch(url, init);
      expect(res.status).toBe(fx.response.status);
      const body = (await res.json()) as unknown;
      for (const path of READS[name] ?? []) {
        const want = typesAt(fx.response.body, path).filter((x) => x !== "null");
        const got = typesAt(body, path).filter((x) => x !== "null");
        expect(typesAt(fx.response.body, path).length, `${name}: fixture lacks ${path}`).toBeGreaterThan(0);
        expect(typesAt(body, path).length, `${name}: fake lacks ${path}`).toBeGreaterThan(0);
        if (want.length && got.length) expect(new Set(got), `${name}: ${path}`).toEqual(new Set(want));
      }
    });
  }
});
