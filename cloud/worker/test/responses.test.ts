/**
 * Response tests: error shapes for JSON and HTML routes, and the headers on every
 * response, errors included.
 *
 * <module-headers:begin>
 * Uses:
 * test/responses.test.ts
 * ├── src/http/responses.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: vitest
 *
 * Used by: entry point (vitest inside workerd, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { beforeAll, describe, expect, it } from "vitest";
import { CSP, errorResponse, finalize, HttpError } from "../src/http/responses.ts";
import { closeSetup, CP_HOST } from "./helpers/seed.ts";
import { handler } from "./helpers/worker.ts";

describe("error shapes", () => {
  it("shapes JSON and HTML errors", async () => {
    const j = errorResponse(new HttpError("forbidden", "nope", { details: { a: 1 } }), "json", "rid-1");
    expect(await j.json()).toEqual({ error: { code: "forbidden", message: "nope", retryable: false, details: { a: 1 } }, request_id: "rid-1" });
    const h = errorResponse(new HttpError("setup_closed", "<b>x</b>"), "html", "rid-2");
    const text = await h.text();
    expect(h.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(text).toContain("&#60;b&#62;x&#60;/b&#62;");
    expect(text).toContain("<code>setup_closed</code>");
    expect(text).toMatch(/<html lang="en">/);
  });
});

describe("finalize", () => {
  it("stamps security headers, protocol, request id and Retry-After", () => {
    for (const status of [200, 429, 503]) {
      const res = finalize(new Response("x", { status }), { requestId: "abc", protocol: 1 });
      expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(res.headers.get("X-Frame-Options")).toBe("DENY");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Yaran-Protocol")).toBe("1");
      expect(res.headers.get("Yaran-Request-Id")).toBe("abc");
      expect(res.headers.has("Retry-After")).toBe(status !== 200);
    }
  });
  it("gives HTML a CSP with no remote script source", () => {
    const res = finalize(new Response("<p>", { headers: { "Content-Type": "text/html" } }), { requestId: "a", protocol: 1 });
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
    expect(CSP).toContain("default-src 'none'");
    expect(CSP).not.toMatch(/script-src[^;]*(https?:|\*)/);
  });
});

describe("pipeline headers", () => {
  beforeAll(() => closeSetup());
  const call = handler();
  it("carries Yaran-Protocol and Yaran-Request-Id on success and error, from CF-Ray when present", async () => {
    const ok = await call(new Request(`https://${CP_HOST}/v1/meta`, { headers: { "CF-Ray": "8d1f2c3b4a5e6f70-LHR" } }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Yaran-Request-Id")).toBe("8d1f2c3b4a5e6f70-LHR");
    expect(ok.headers.get("Cache-Control")).toBe("public, max-age=60");
    const err = await call(new Request(`https://${CP_HOST}/nope`));
    expect(err.status).toBe(404);
    expect(err.headers.get("Yaran-Protocol")).toBe("1");
    const body = (await err.json()) as { request_id: string };
    expect(body.request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(err.headers.get("Yaran-Request-Id")).toBe(body.request_id);
    expect(err.headers.get("X-Frame-Options")).toBe("DENY");
  });
  it("turns an unexpected exception into 500 internal without leaking its text", async () => {
    const boom = handler({}, [{ method: "GET", path: "/v1/meta", auth: { kind: "public" }, kind: "json", protocol: "none", rateLimit: "ip",
      handler: async () => { throw new Error("secret-ish detail"); } }]);
    const res = await boom(new Request(`https://${CP_HOST}/v1/meta`));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret-ish");
  });
});
