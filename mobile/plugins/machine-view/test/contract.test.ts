/**
 * Contract checks on definitions.ts: mocks satisfy it, the web fallback refuses, and no
 * method hands JS a credential (D22).
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
 * └── src/web.ts
 * External: node:fs, vitest
 *
 * Used by: entry point (vitest, via npm test in the plugin package)
 * <module-headers:end>
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MachineViewPlugin, SessionPlugin } from "../src/definitions.ts";
import { MachineViewWeb, SessionWeb } from "../src/web.ts";

const machineViewMock = {
  open: async () => {},
  close: async () => {},
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
} satisfies SessionPlugin;

describe("definitions", () => {
  it("accepts the mock shapes", async () => {
    expect(await machineViewMock.open()).toBeUndefined();
    expect((await sessionMock.signIn()).kind).toBe("signed_in");
  });

  it("the web fallback rejects every call with unavailable", async () => {
    const s = new SessionWeb();
    for (const call of [s.meta, s.signIn, s.status, s.request, s.installId, s.deviceKey, s.callbackMode, s.signOut]) {
      await expect(call()).rejects.toMatchObject({ code: "unavailable" });
    }
    await expect(new MachineViewWeb().open()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("names no credential in any declaration", () => {
    const src = readFileSync(new URL("../src/definitions.ts", import.meta.url), "utf8").replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/\b(jwt|cookie|token|privateKey|secret|bearer)\b/i);
  });
});
