/**
 * The shell's machine opener: host resolution, route refusal and closed-event routing.
 *
 * - `MachineView.open` is a recorded fake; the machines list is an in-memory stand-in for
 *   Phase 14's store.
 *
 * <module-headers:begin>
 * Uses:
 * test/openMachine.test.ts
 * ├── src/definitions.ts
 * └── src/openMachine.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/plugins/machine-view)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import type { OpenOptions } from "../src/definitions.ts";
import { closedDestination, openAgent, openMachine, type OpenMachineDeps } from "../src/openMachine.ts";

const ORG = "org-1";
const MACHINE = "0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a";

function deps(): OpenMachineDeps & { opened: OpenOptions[] } {
  const opened: OpenOptions[] = [];
  return {
    opened,
    machines: (orgId) => (orgId === ORG ? [{ id: MACHINE, hostname: "laptop-ada.example.com" }] : undefined),
    machineView: { open: async (o) => void opened.push(o) },
  };
}

describe("openMachine", () => {
  it("opens the host from the machines list, never a caller-supplied one", async () => {
    const d = deps();
    expect(await openMachine(d, ORG, MACHINE)).toEqual({ ok: true });
    expect(d.opened).toEqual([{ orgId: ORG, machineId: MACHINE, host: "laptop-ada.example.com" }]);
  });

  it("refuses an unknown machine, an unknown org and a never-loaded list", async () => {
    const d = deps();
    expect(await openMachine(d, ORG, "other")).toEqual({ ok: false, reason: "unknown_machine" });
    expect(await openMachine(d, "org-2", MACHINE)).toEqual({ ok: false, reason: "unknown_machine" });
    expect(d.opened).toEqual([]);
  });

  it("refuses a route outside the agent grammar", async () => {
    const d = deps();
    expect(await openMachine(d, ORG, MACHINE, "#/terminal/t1")).toEqual({ ok: false, reason: "bad_route" });
    expect(await openMachine(d, ORG, MACHINE, "javascript:alert(1)")).toEqual({ ok: false, reason: "bad_route" });
    expect(d.opened).toEqual([]);
  });

  it("openAgent builds and passes the encoded route", async () => {
    const d = deps();
    expect(await openAgent(d, ORG, MACHINE, "sess 1", "tab/2")).toEqual({ ok: true });
    expect(d.opened[0]?.route).toBe("#/agent/sess%201/tab/tab%2F2");
    expect(await openAgent(d, ORG, MACHINE, "")).toEqual({ ok: false, reason: "bad_route" });
  });
});

describe("closedDestination", () => {
  it("routes every reason", () => {
    expect(closedDestination({ reason: "user" })).toBe("machines");
    expect(closedDestination({ reason: "home" })).toBe("machines");
    expect(closedDestination({ reason: "error", code: "renderer_gone" })).toBe("machines");
    expect(closedDestination({ reason: "settings" })).toBe("settings");
    expect(closedDestination({ reason: "signedOut" })).toBe("org_sign_in");
  });
});
