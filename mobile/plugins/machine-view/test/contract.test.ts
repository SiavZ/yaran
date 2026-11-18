/**
 * Contract checks on definitions.ts: mocks satisfy it, the web fallback refuses, no method
 * hands JS a credential (D22), the original org open form still type-checks, and every
 * new outcome union is exhaustive (a switch ending in assertNever).
 *
 * The mock objects are the shape Phase 14's and Phase 16's Vitest mocks take; `satisfies`
 * makes a drift between them and the definitions a type error.
 *
 * - Reads `src/definitions.ts` as text for the credential-name review.
 *
 * <module-headers:begin>
 * Uses:
 * test/contract.test.ts
 * ├── src/definitions.ts
 * ├── src/outcomes.ts
 * └── src/web.ts
 * External: node:fs, vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MachineViewPlugin, OpenOptions, SessionPlugin } from "../src/definitions.ts";
import { MAX_ROUTES, MAX_SHARED_FILES } from "../src/definitions.ts";
import {
  assertNever,
  type ClosedEvent,
  type DirectClosedCode,
  type DirectSignInOutcome,
  type DirectSignOutOutcome,
  type DirectStatus,
  type RouteStatus,
  type ShareReceivedEvent,
  type ShareStatus,
} from "../src/outcomes.ts";
import { MachineViewWeb, SessionWeb } from "../src/web.ts";

const machineViewMock = {
  open: async () => {},
  close: async () => {},
  shareStatus: async () => ({ kind: "none" as const }),
  discardShare: async (_options: { batch: string }) => {},
  addListener: async () => ({ remove: async () => {} }),
  removeAllListeners: async () => {},
} satisfies MachineViewPlugin;

const sessionMock = {
  meta: async () => ({ kind: "offline" as const }),
  signIn: async () => ({ kind: "signed_in" as const, host: "h.example.com", email: "a@b.c", expiresAt: 1 }),
  status: async () => ({ signedIn: false }),
  request: async () => ({ kind: "ok" as const, status: 200, body: {} }),
  installId: async () => ({ installId: "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a" }),
  deviceKey: async () => ({ deviceKey: "B".padEnd(87, "A") }),
  callbackMode: async () => ({ mode: "dev" as const }),
  signOut: async () => {},
  directStatus: async () => ({ kind: "offline" as const }),
  directSignIn: async () => ({ kind: "cancelled" as const }),
  directSignOut: async () => ({ kind: "signed_out" as const, serverEnded: true }),
  routeStatus: async () => ({ kind: "sign_in_required" as const }),
} satisfies SessionPlugin;

// The three open forms. The first is exactly what the shell sent before G1 (no `kind`).
const opens = [
  { orgId: "https://cp.example.com", machineId: "m1", host: "laptop-ada.example.com", route: "#/agent/a1" },
  { kind: "org", orgId: "https://cp.example.com", machineId: "m1", host: "laptop-ada.example.com", shareBatch: "8d1c9a7e-3b0f-4b8e-9a51-2f6c0d4e7b13" },
  { kind: "direct", host: "laptop.tail1234.ts.net", instance: "i-1" },
  {
    kind: "routes",
    instance: "i-1",
    routes: [
      { kind: "direct", host: "laptop.tail1234.ts.net" },
      { kind: "org", orgId: "https://cp.example.com", machineId: "m1", host: "laptop-ada.example.com" },
    ],
  },
] satisfies OpenOptions[];

function openTarget(o: OpenOptions): string {
  switch (o.kind) {
    case undefined:
    case "org":
      return o.host;
    case "direct":
      return o.host;
    case "routes":
      return o.routes.map((r) => r.host).join(",");
    default:
      return assertNever(o);
  }
}

function statusKind(s: DirectStatus): string {
  switch (s.kind) {
    case "yaran":
      return `${s.requiredHere && !s.signedIn ? "sign_in" : "open"}:${s.instance ?? "none"}`;
    case "not_yaran":
    case "access_required":
    case "redirected":
    case "offline":
    case "tls_error":
    case "vault_locked":
    case "upgrade_required":
      return s.kind;
    case "refused":
      return s.reason;
    default:
      return assertNever(s);
  }
}

function signInKind(o: DirectSignInOutcome): string {
  switch (o.kind) {
    case "signed_in":
      return o.host;
    case "rate_limited":
      return `${o.retryAfterSeconds}:${o.message}`;
    case "wrong_password":
    case "no_password":
      return o.message;
    case "server_refused":
      return `${o.status}:${o.code}`;
    case "refused":
      return o.reason;
    case "not_required":
    case "cancelled":
    case "not_yaran":
    case "access_required":
    case "redirected":
    case "offline":
    case "tls_error":
    case "vault_locked":
    case "upgrade_required":
    case "secure_storage_failed":
      return o.kind;
    default:
      return assertNever(o);
  }
}

function routeKind(r: RouteStatus): string {
  return r.kind === "sign_in_required" ? r.kind : statusKind(r);
}

function signOutKind(o: DirectSignOutOutcome): string {
  switch (o.kind) {
    case "signed_out":
      return String(o.serverEnded);
    case "not_current":
    case "vault_locked":
    case "secure_storage_failed":
      return o.kind;
    case "refused":
      return o.reason;
    default:
      return assertNever(o);
  }
}

function shareKind(e: ShareReceivedEvent | ShareStatus): string {
  switch (e.kind) {
    case "files":
      return `${e.count}+${e.dropped}@${e.batch}`;
    case "pending":
      return `${e.count}@${e.batch}`;
    case "refused":
      return e.reason;
    case "none":
      return e.kind;
    default:
      return assertNever(e);
  }
}

describe("definitions", () => {
  it("accepts the mock shapes", async () => {
    expect(await machineViewMock.open()).toBeUndefined();
    expect((await sessionMock.signIn()).kind).toBe("signed_in");
  });

  it("the web fallback rejects every call with unavailable", async () => {
    const s = new SessionWeb();
    const sessionCalls = [s.meta, s.signIn, s.status, s.request, s.installId, s.deviceKey, s.callbackMode, s.signOut];
    for (const call of [...sessionCalls, s.directStatus, s.directSignIn, s.directSignOut, s.routeStatus]) {
      await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    }
    const m = new MachineViewWeb();
    for (const call of [m.open, m.close, m.shareStatus, m.discardShare]) {
      await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    }
  });

  it("names no credential in any declaration or outcome", () => {
    const strip = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(strip("../src/definitions.ts")).not.toMatch(/\b(jwt|cookie|token|privateKey|secret|bearer|password)\b/i);
    // Outcomes may NAME a password refusal, but no field may carry a credential or a shared file.
    expect(strip("../src/outcomes.ts")).not.toMatch(/\b(jwt|cookie|token|privateKey|secret|bearer|password|uris?|fileNames?)\??:/i);
  });

  it("keeps the original org open form and covers every new union", () => {
    expect(opens.map(openTarget)).toEqual([
      "laptop-ada.example.com",
      "laptop-ada.example.com",
      "laptop.tail1234.ts.net",
      "laptop.tail1234.ts.net,laptop-ada.example.com",
    ]);
    expect(statusKind({ kind: "yaran", instance: null, passwordSet: true, requiredHere: true, signedIn: false, transportEncrypted: true })).toBe(
      "sign_in:none",
    );
    expect(signInKind({ kind: "rate_limited", retryAfterSeconds: 3, message: "Wait." })).toBe("3:Wait.");
    expect(signOutKind({ kind: "signed_out", serverEnded: false })).toBe("false");
    expect(signOutKind({ kind: "not_current" })).toBe("not_current");
    expect(signInKind({ kind: "signed_in", host: "h.example.com", instance: null, signInId: "AAAAAAAAAAAAAAAAAAAAAA" })).toBe("h.example.com");
    expect(routeKind({ kind: "sign_in_required" })).toBe("sign_in_required");
    expect(routeKind({ kind: "offline" })).toBe(statusKind({ kind: "offline" }));
    expect(shareKind({ kind: "files", count: MAX_SHARED_FILES, dropped: 2, batch: "b1" })).toBe("10+2@b1");
    expect(shareKind({ kind: "pending", count: 3, batch: "b1" })).toBe("3@b1");
    expect(MAX_ROUTES).toBe(4);
    const legacy: ClosedEvent = { reason: "user" };
    const changed: ClosedEvent = { reason: "error", code: "instance_changed", host: "a.example.com", requestedHost: "a.example.com" };
    expect([legacy.host, changed.host]).toEqual([undefined, "a.example.com"]);
    const old: DirectClosedCode = "upgrade_required";
    expect(statusKind({ kind: "upgrade_required" })).toBe(old);
    expect(signInKind({ kind: "upgrade_required" })).toBe(old);
    expect(routeKind({ kind: "upgrade_required" })).toBe(old);
  });
});
