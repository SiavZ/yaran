/**
 * Cloudflare client: envelope parsing, retries, timeout, base URL (hook H3), token hygiene.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/client.test.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/errors.ts
 * ├── test/provisioning/helpers/d1.ts
 * └── test/provisioning/helpers/world.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm run test:provisioning in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { ApiBudget } from "../../src/cloudflare/budget.ts";
import { CfClient, DEFAULT_CF_API_BASE_URL, resolveCfBaseUrl } from "../../src/cloudflare/client.ts";
import { CfApiError } from "../../src/cloudflare/errors.ts";
import { FakeD1 } from "./helpers/d1.ts";
import { TOKEN } from "./helpers/world.ts";

interface Seen {
  url: string;
  method: string;
  auth: string | null;
}

function client(respond: (n: number, init?: RequestInit) => Promise<Response> | Response, timeoutMs?: number) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), method: init?.method ?? "GET", auth: new Headers(init?.headers).get("authorization") });
    return respond(seen.length, init);
  }) as typeof fetch;
  const db = new FakeD1();
  const c = new CfClient({
    fetch: fetchFn,
    token: TOKEN,
    baseUrl: DEFAULT_CF_API_BASE_URL,
    budget: new ApiBudget(db, () => 1000),
    userAgent: "yaran-cloud/test",
    sleep: async () => {},
    random: () => 0.5,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  return { c, seen };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

async function caught(p: Promise<unknown>): Promise<CfApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CfApiError) return e;
    throw e;
  }
  throw new Error("expected a CfApiError");
}

describe("CfClient", () => {
  it("returns the envelope on success and sends the bearer token", async () => {
    const { c, seen } = client(() => json(200, { success: true, errors: [], result: { id: "x" } }));
    const env = await c.request<{ id: string }>("GET", "/zones/z", { priority: "interactive", query: { a: 1, b: undefined } });
    expect(env.result.id).toBe("x");
    expect(seen[0]?.url).toBe(`${DEFAULT_CF_API_BASE_URL}/zones/z?a=1`);
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("treats success:false on a 200 as an error", async () => {
    const { c } = client(() => json(200, { success: false, errors: [{ code: 1001, message: "bad" }], result: null }));
    const e = await caught(c.request("POST", "/x", { priority: "interactive", body: {} }));
    expect(e.kind).toBe("invalid");
    expect(e.cfErrors[0]?.code).toBe(1001);
  });

  it("classifies a non-JSON 5xx as transient with the status", async () => {
    const { c } = client(() => new Response("<html>", { status: 502 }));
    const e = await caught(c.request("POST", "/x", { priority: "interactive" }));
    expect(e).toMatchObject({ kind: "transient", status: 502 });
  });

  it("retries GET, PUT and DELETE twice on transient errors, never POST or PATCH", async () => {
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const { c, seen } = client(() => json(503, { success: false, errors: [], result: null }));
      await caught(c.request(method, "/x", { priority: "interactive" }));
      expect(seen).toHaveLength(3);
    }
    for (const method of ["POST", "PATCH"] as const) {
      const { c, seen } = client(() => json(503, { success: false, errors: [], result: null }));
      await caught(c.request(method, "/x", { priority: "interactive" }));
      expect(seen).toHaveLength(1);
    }
    const { c, seen } = client((n) => (n < 3 ? json(500, {}) : json(200, { success: true, errors: [], result: 1 })));
    expect((await c.request("GET", "/x", { priority: "interactive" })).result).toBe(1);
    expect(seen).toHaveLength(3);
  });

  it("aborts after the timeout and reports transient", async () => {
    const { c } = client(
      (_n, init) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
      20,
    );
    const e = await caught(c.request("POST", "/slow", { priority: "interactive" }));
    expect(e.kind).toBe("transient");
  });

  it("never carries the token in an error", async () => {
    const { c } = client(() => json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }));
    const e = await caught(c.request("GET", "/accounts/a/cfd_tunnel", { priority: "interactive" }));
    expect(e.kind).toBe("auth");
    expect(JSON.stringify({ ...e, message: e.message, stack: e.stack })).not.toContain(TOKEN);
  });
});

describe("resolveCfBaseUrl (Phase 19 hook H3)", () => {
  it("defaults to the public API when unset", () => {
    expect(resolveCfBaseUrl(undefined)).toBe("https://api.cloudflare.com/client/v4");
    expect(resolveCfBaseUrl("")).toBe("https://api.cloudflare.com/client/v4");
  });
  it("uses CF_API_BASE_URL when set", async () => {
    expect(resolveCfBaseUrl("https://chaos.staging.example/client/v4/")).toBe("https://chaos.staging.example/client/v4");
    const seen: string[] = [];
    const c = new CfClient({
      fetch: (async (u: RequestInfo | URL) => (seen.push(String(u)), Response.json({ success: true, errors: [], result: null }))) as typeof fetch,
      token: TOKEN,
      baseUrl: resolveCfBaseUrl("https://chaos.staging.example/client/v4"),
      budget: new ApiBudget(new FakeD1(), () => 0),
      userAgent: "t",
      sleep: async () => {},
    });
    await c.request("GET", "/zones/z", { priority: "interactive" });
    expect(seen[0]).toBe("https://chaos.staging.example/client/v4/zones/z");
  });
  it("refuses anything but https", () => {
    expect(() => resolveCfBaseUrl("http://api.cloudflare.com/client/v4")).toThrow(/https/);
    expect(() => resolveCfBaseUrl("not a url")).toThrow(/CF_API_BASE_URL/);
  });
});
