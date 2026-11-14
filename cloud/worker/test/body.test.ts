/**
 * Pipeline steps 5 and 6: protocol negotiation, body size and type, the CSRF rule, and
 * schema-validated JSON through `@yaran/protocol`.
 *
 * <module-headers:begin>
 * Uses:
 * test/body.test.ts
 * ├── src/http/body.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * ├── src/http/routes.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/seed.ts
 * └── test/helpers/worker.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readJson } from "../src/http/body.ts";
import type { RequestContext } from "../src/http/context.ts";
import { HttpError, json } from "../src/http/responses.ts";
import type { Route } from "../src/http/routes.ts";
import { mintJwt, serveJwks } from "./helpers/access.ts";
import { closeSetup, CP_HOST, seedUser } from "./helpers/seed.ts";
import { errorCode, handler } from "./helpers/worker.ts";

const call = handler();
let jwt = "";
beforeAll(async () => {
  await closeSetup();
  const u = await seedUser();
  jwt = await mintJwt({ email: u.email });
});

const userReq = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`https://${CP_HOST}${path}`, { ...init, headers: { "Cf-Access-Jwt-Assertion": jwt, "Yaran-Protocol": "1", ...init.headers } });

describe("protocol negotiation", () => {
  it("refuses a missing or out-of-range Yaran-Protocol with {min, max}", async () => {
    for (const value of [null, "0", "2", "01", "x"]) {
      const headers: Record<string, string> = { "Cf-Access-Jwt-Assertion": jwt };
      if (value !== null) headers["Yaran-Protocol"] = value;
      const res = await call(new Request(`https://${CP_HOST}/v1/me`, { headers }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string; details: unknown } }).error).toMatchObject({ code: "protocol_unsupported", details: { min: 1, max: 1 } });
    }
  });
  it("needs no header on /v1/meta and checks `v` on HTML navigations", async () => {
    expect((await call(new Request(`https://${CP_HOST}/v1/meta`))).status).toBe(200);
    serveJwks();
    expect(await errorCode(await call(userReq("/v1/handoff")))).toBe("protocol_unsupported");
    expect((await call(userReq("/v1/handoff?v=1"))).status).toBe(200);
  });
});

describe("body and CSRF", () => {
  it("refuses a body over the cap with 413, by header and by stream", async () => {
    const big = "x".repeat(64 * 1024 + 1);
    const res = await call(userReq("/v1/me/devices", { method: "POST", body: big, headers: { "Content-Type": "application/json" } }));
    expect(res.status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res2 = await call(userReq("/v1/me/devices", { method: "POST", body: stream, headers: { "Content-Type": "application/json" } }));
    expect(res2.status).toBe(413);
  });
  it("requires application/json on console mutations and any JSON body (bodyless DELETE excepted)", async () => {
    serveJwks();
    const form = await call(userReq("/v1/me/devices", { method: "POST", body: "a=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
    expect(await errorCode(form)).toBe("unsupported_media_type");
    const empty = await call(userReq("/v1/me/devices", { method: "POST" }));
    expect(empty.status).toBe(415);
    expect((await call(userReq("/v1/me/devices/abc", { method: "DELETE" }))).status).toBe(200);
    expect((await call(userReq("/v1/me/devices", { method: "POST", body: "{}", headers: { "Content-Type": "application/json; charset=utf-8" } }))).status).toBe(200);
  });
  it("refuses a foreign Origin on console mutations and form posts, and accepts our own", async () => {
    serveJwks();
    const foreign = { "Content-Type": "application/json", Origin: "https://evil.example" };
    expect(await errorCode(await call(userReq("/v1/me/devices", { method: "POST", body: "{}", headers: foreign })))).toBe("origin_mismatch");
    expect(await errorCode(await call(userReq("/v1/admin/settings", { method: "PUT", body: "{}", headers: foreign })))).toBe("origin_mismatch");
    expect(await errorCode(await call(userReq("/v1/handoff?v=1", { method: "POST", body: "a=1", headers: { Origin: "https://evil.example" } })))).toBe("origin_mismatch");
    const own = await call(userReq("/v1/me/devices", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", Origin: `https://${CP_HOST}` } }));
    expect(own.status).toBe(200);
  });
});

describe("readJson", () => {
  const ctxWith = (text: string) => ({ body: new TextEncoder().encode(text) }) as RequestContext;
  it("validates against a Phase 02 schema type and reports JSON pointers", () => {
    expect(readJson(ctxWith('{"origin_port":3890}'), "OriginUpdate")).toEqual({ origin_port: 3890 });
    try {
      readJson(ctxWith('{"origin_port":0}'), "OriginUpdate");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).code).toBe("validation_failed");
      expect((err as HttpError).details).toEqual({ errors: [expect.objectContaining({ path: "/origin_port" })] });
    }
    expect(() => readJson(ctxWith("{"), "OriginUpdate")).toThrow(HttpError);
  });
  it("is reachable from a handler as a 400 response", async () => {
    const route: Route = { method: "PUT", path: "/v1/machine/origin", auth: { kind: "public" }, kind: "json", protocol: "none", rateLimit: "ip",
      handler: async (ctx) => json(readJson(ctx, "OriginUpdate")) };
    const res = await handler({}, [route])(new Request(`https://${CP_HOST}/v1/machine/origin`, { method: "PUT", body: '{"port":"x"}', headers: { "Content-Type": "application/json" } }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_failed");
  });
});
