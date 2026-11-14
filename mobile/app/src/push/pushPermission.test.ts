/**
 * Row presentation for every `OrgRowState`, reason sanitizing, and the permission flow: ask
 * only from the explicit step, rationale when asked for, system settings on a permanent deny.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushPermission.test.ts
 * ├── src/push/pushPermission.ts
 * ├── src/push/pushStrings.ts
 * └── src/push/pushTestKit.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { rowView, sanitizeReason, turnOnPermission } from "./pushPermission.ts";
import { pushStrings } from "./pushStrings.ts";
import { ALL_STATES, fakePush } from "./pushTestKit.ts";


describe("row states", () => {
  it("every state has a worded title and a known action", () => {
    for (const state of ALL_STATES) {
      const view = rowView(state);
      expect(pushStrings[view.title], state.kind).toBeTruthy();
    }
    expect(rowView({ kind: "needs_permission" }).action).toBe("allow");
    expect(rowView({ kind: "no_distributor" }).action).toBe("distributors");
    expect(rowView({ kind: "delivery_failing" }).action).toBeNull();
    expect(rowView({ kind: "turned_off" }).action).toBe("turn_on");
    expect(rowView({ kind: "muted", until: "x" }).title).toBe("push.row.muted.until");
  });

  it("sanitizes reasons", () => {
    expect(sanitizeReason("bad‮txt\u001b[31m")).toBe("badtxt[31m");
    expect([...sanitizeReason("x".repeat(500))].length).toBe(200);
  });
});

describe("permission flow", () => {
  const ui = (rationale = true, settings = true) => {
    const seen: string[] = [];
    return {
      seen,
      ui: {
        showRationale: async () => (seen.push("rationale"), rationale),
        offerSettings: async () => (seen.push("settings"), settings),
      },
    };
  };

  it("asks when the OS has not asked yet", async () => {
    const { push } = fakePush({ permission: "granted" });
    const { ui: u, seen } = ui();
    expect(await turnOnPermission(push, u)).toBe("granted");
    expect(seen).toEqual([]);
  });

  it("shows the rationale first when Android asks for one", async () => {
    const { push } = fakePush({ permission: "prompt-with-rationale" });
    const { ui: u, seen } = ui(false);
    expect(await turnOnPermission(push, u)).toBe("declined");
    expect(seen).toEqual(["rationale"]);
  });

  it("offers system settings on a permanent deny", async () => {
    const { push, calls } = fakePush({ permission: "denied" });
    const { ui: u, seen } = ui();
    expect(await turnOnPermission(push, u)).toBe("settings");
    expect(seen).toEqual(["settings"]);
    expect(calls.some((c) => c.method === "openNotificationSettings")).toBe(true);
  });
});
