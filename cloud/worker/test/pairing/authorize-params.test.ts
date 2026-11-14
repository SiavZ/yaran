/**
 * Accept/refuse tables for the W2 validators, one rule at a time, then the ordered
 * parse: a refusal redirects only once the callback and state are valid.
 *
 * <module-headers:begin>
 * Uses:
 * test/pairing/authorize-params.test.ts
 * ├── src/pairing/authorize-params.ts
 * └── test/pairing/pair-helpers.ts
 * External: vitest
 *
 * Used by: entry point (vitest in the Workers pool, via npm test in cloud/worker)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import {
  callbackPort,
  checkChallenge,
  checkMachineName,
  checkMachinePubkey,
  checkOriginPort,
  checkState,
  checkVersion,
  checkYaranVersion,
  parseAuthorizeQuery,
} from "../../src/pairing/authorize-params.ts";
import { authorizeQuery, fixtureMachine } from "./pair-helpers.ts";

describe("callback", () => {
  it.each([
    ["http://127.0.0.1:43123/callback", 43123],
    ["http://127.0.0.1:1024/callback", 1024],
    ["http://127.0.0.1:65535/callback", 65535],
    ["http://127.0.0.1:1023/callback", null],
    ["http://127.0.0.1:65536/callback", null],
    ["http://127.0.0.1:80/callback", null],
    ["http://127.0.0.1/callback", null],
    ["http://localhost:43123/callback", null],
    ["http://[::1]:43123/callback", null],
    ["https://127.0.0.1:43123/callback", null],
    ["HTTP://127.0.0.1:43123/callback", null],
    ["http://127.0.0.1:43123/callback/", null],
    ["http://127.0.0.1:43123/other", null],
    ["http://127.0.0.1:43123/callback?x=1", null],
    ["http://127.0.0.1:43123/callback#f", null],
    ["http://user@127.0.0.1:43123/callback", null],
    ["http://127.0.0.1:043123/callback", null],
    ["http://127.0.0.2:43123/callback", null],
  ])("%s → %s", (cb, port) => expect(callbackPort(cb)).toBe(port));
  it("refuses a missing callback", () => expect(callbackPort(null)).toBeNull());
});

describe("state, version, challenge", () => {
  it.each([
    ["a".repeat(22), true],
    ["a".repeat(128), true],
    ["a".repeat(21), false],
    ["a".repeat(129), false],
    ["a".repeat(21) + "=", false],
    ["a".repeat(21) + "+", false],
  ])("state %s → %s", (s, ok) => expect(checkState(s)).toBe(ok));
  it("version must be in the served range", () => {
    expect(checkVersion("1")).toBeNull();
    expect(checkVersion("2")).toEqual({ min: 1, max: 1 });
    expect(checkVersion("01")).toEqual({ min: 1, max: 1 });
    expect(checkVersion(null)).toEqual({ min: 1, max: 1 });
  });
  it("challenge is 43 base64url chars with S256", () => {
    const c = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(checkChallenge(c, "S256")).toBeNull();
    expect(checkChallenge(c, "plain")).toBe("pair_request_invalid");
    expect(checkChallenge(c, null)).toBe("pair_request_invalid");
    expect(checkChallenge(c.slice(1), "S256")).toBe("pair_request_invalid");
    expect(checkChallenge(c + "A", "S256")).toBe("pair_request_invalid");
  });
});

describe("machine key, name, port, version", () => {
  it("accepts a real Ed25519 key and refuses other lengths and encodings", async () => {
    const m = await fixtureMachine();
    expect(await checkMachinePubkey(m.keys.publicB64)).toEqual(m.keys.publicKey);
    expect(await checkMachinePubkey(m.keys.publicB64.slice(0, 42))).toBeNull();
    expect(await checkMachinePubkey(m.keys.publicB64 + "A")).toBeNull();
    expect(await checkMachinePubkey(m.keys.publicB64.replace(/^./, "+"))).toBeNull();
    expect(await checkMachinePubkey(null)).toBeNull();
  });
  it.each([
    ["laptop", true],
    ["a", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["-laptop", false],
    ["laptop-", false],
    ["Laptop", false],
    ["lap top", false],
    ["läptop", false],
  ])("name %s → %s", (n, ok) => expect(checkMachineName(n)).toBe(ok));
  it.each([
    [null, 3890],
    ["1", 1],
    ["65535", 65535],
    ["0", null],
    ["65536", null],
    ["08080", null],
    ["80a", null],
  ])("origin_port %s → %s", (p, port) => expect(checkOriginPort(p)).toBe(port));
  it("yaran_version is 1-40 printable characters", () => {
    expect(checkYaranVersion("0.42.0")).toBe(true);
    expect(checkYaranVersion("x".repeat(41))).toBe(false);
    expect(checkYaranVersion("")).toBe(false);
    expect(checkYaranVersion("1.0 beta")).toBe(false);
  });
});

describe("parseAuthorizeQuery", () => {
  it("accepts a well-formed request and defaults origin_port to 3890", async () => {
    const m = await fixtureMachine();
    const r = await parseAuthorizeQuery(authorizeQuery(m));
    expect(r.ok && r.q.originPort).toBe(3890);
  });
  it("answers a page (no redirect) for a bad callback or state", async () => {
    const m = await fixtureMachine();
    expect(await parseAuthorizeQuery(authorizeQuery(m, { callback: "http://localhost:1/callback" }))).toMatchObject({ ok: false, code: "pair_callback_invalid", redirect: null });
    expect(await parseAuthorizeQuery(authorizeQuery(m, { state: "short" }))).toMatchObject({ ok: false, code: "pair_request_invalid", redirect: null });
  });
  it.each([
    [{ v: "9" }, "protocol_unsupported"],
    [{ code_challenge_method: "plain" }, "pair_request_invalid"],
    [{ machine_pubkey: "AAAA" }, "pair_request_invalid"],
    [{ machine_name: "Bad_Name" }, "machine_name_invalid"],
    [{ origin_port: "0" }, "origin_port_invalid"],
    [{ yaran_version: null }, "pair_request_invalid"],
    [{ extra: "1" }, "pair_request_invalid"],
  ] as [Record<string, string | null>, string][])("%o → redirect with %s", async (over, code) => {
    const m = await fixtureMachine();
    const r = await parseAuthorizeQuery(authorizeQuery(m, over));
    expect(r).toMatchObject({ ok: false, code, redirect: { port: m.port, state: m.state } });
  });
  it("adds min and max for protocol_unsupported", async () => {
    const m = await fixtureMachine();
    expect(await parseAuthorizeQuery(authorizeQuery(m, { v: "2" }))).toMatchObject({ details: { min: 1, max: 1 } });
  });
});
