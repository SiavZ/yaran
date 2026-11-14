/**
 * Tap routing: unknown machine, known machine, a payload without `t`, ids carrying `/` or `#`,
 * the mute action and malformed events.
 *
 * <module-headers:begin>
 * Uses:
 * mobile/app/src/push/notificationTap.test.ts
 * ├── mobile/app/src/push/notificationTap.ts
 * └── mobile/app/src/push/pushTestKit.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/plugins/push until Phase 14's mobile/app runs them)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { agentRoute, handleTap, type TapDeps } from "./notificationTap.ts";
import { fakePush, MACHINE } from "./pushTestKit.ts";

function deps() {
  const { push, calls } = fakePush();
  const log: string[] = [];
  const opened: { orgId: string; machineId: string; route: string }[] = [];
  const d: TapDeps = {
    push,
    pairedMachineIds: (orgId) => (orgId === "org-1" ? [MACHINE] : []),
    openAgent: async (o) => {
      opened.push(o);
    },
    showMachines: (orgId) => log.push(`machines:${orgId}`),
    muteMachine: async (orgId, machineId) => {
      log.push(`mute:${orgId}:${machineId}`);
    },
    toast: (key) => log.push(key),
  };
  return { d, calls, log, opened };
}

describe("notification taps", () => {
  it("opens a known machine at the agent tab and clears its deliveries", async () => {
    const { d, calls, opened } = deps();
    expect(await handleTap(d, { orgId: "org-1", machineId: MACHINE, agentId: "a1", tabId: "t2", action: "open" })).toBe("opened");
    expect(opened).toEqual([{ orgId: "org-1", machineId: MACHINE, route: "#/agent/a1/tab/t2" }]);
    expect(calls.find((c) => c.method === "clearDelivered")?.args).toEqual({ orgId: "org-1", machineId: MACHINE, agentId: "a1", tabId: "t2" });
  });

  it("opens the bare agent hash when the payload omitted t", async () => {
    const { d, opened } = deps();
    await handleTap(d, { orgId: "org-1", machineId: MACHINE, agentId: "a1", action: "open" });
    expect(opened[0]?.route).toBe("#/agent/a1");
  });

  it("never loads anything for an unpaired machine", async () => {
    const { d, log, opened } = deps();
    expect(await handleTap(d, { orgId: "org-1", machineId: "11111111-1111-4111-8111-111111111111", agentId: "a", action: "open" })).toBe("unpaired");
    expect(opened).toEqual([]);
    expect(log).toEqual(["push.toast.machine_unpaired", "machines:org-1"]);
  });

  it("encodes / and # so an id cannot change the route", () => {
    expect(agentRoute("a/../../x#y", "t#/z")).toBe("#/agent/a%2F..%2F..%2Fx%23y/tab/t%23%2Fz");
    expect(agentRoute("a?b=1")).toBe("#/agent/a%3Fb%3D1");
  });

  it("routes the mute action to the mute sync", async () => {
    const { d, log, opened } = deps();
    expect(await handleTap(d, { orgId: "org-1", machineId: MACHINE, action: "mute_machine" })).toBe("muted");
    expect(log).toEqual([`mute:org-1:${MACHINE}`]);
    expect(opened).toEqual([]);
  });

  it("ignores malformed taps, including one naming a host", async () => {
    const { d, opened } = deps();
    expect(await handleTap(d, { host: "evil.example", orgId: "org-1", machineId: MACHINE, action: "open" })).toBe("invalid");
    expect(await handleTap(d, "#/agent/x")).toBe("invalid");
    expect(opened).toEqual([]);
  });
});
