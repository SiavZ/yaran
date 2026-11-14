/**
 * Renders the Notifications section for every row state and checks the controls each offers.
 *
 * - Runs in jsdom (the pragma below).
 *
 * @vitest-environment jsdom
 *
 * <module-headers:begin>
 * Uses:
 * src/push/NotificationSettingsSection.test.tsx
 * ├── src/push/NotificationSettingsSection.tsx
 * ├── src/push/pushStrings.ts
 * └── src/push/pushTestKit.ts
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NotificationSettingsSection, type NotificationSettingsProps } from "./NotificationSettingsSection.tsx";
import { pushStrings, type PushStringKey } from "./pushStrings.ts";
import { ALL_STATES, MACHINE } from "./pushTestKit.ts";

afterEach(cleanup);

function setup(overrides: Partial<NotificationSettingsProps> = {}) {
  const events: string[] = [];
  const props: NotificationSettingsProps = {
    rows: ALL_STATES.map((state, i) => ({ orgId: `org-${i}`, orgName: `Org ${i}`, state, machines: [{ id: MACHINE, name: "build-box", muted: false }] })),
    distributors: null,
    t: (key: PushStringKey, vars) => pushStrings[key].replace("{until}", vars?.until ?? ""),
    onAction: (orgId, action) => events.push(`${action}:${orgId}`),
    onTurnOff: (orgId) => events.push(`off:${orgId}`),
    onMuteOrg: (orgId, mode) => events.push(`mute-${mode}:${orgId}`),
    onMuteMachine: (orgId, machineId, muted) => events.push(`machine:${orgId}:${machineId}:${muted}`),
    onSelectDistributor: (d) => events.push(`distributor:${d}`),
    ...overrides,
  };
  const view = render(<NotificationSettingsSection {...props} />);
  return { view, events };
}

describe("NotificationSettingsSection", () => {
  it("renders one row per state with its words", () => {
    const { view } = setup();
    const rows = view.container.querySelectorAll("li[data-state]");
    expect([...rows].map((r) => r.getAttribute("data-state"))).toEqual(ALL_STATES.map((s) => s.kind));
    expect(screen.getByText(pushStrings["push.row.no_distributor"])).toBeTruthy();
    expect(screen.getByText("Muted on this phone until 2026-11-14T13:00:00Z")).toBeTruthy();
    expect(screen.getByText(pushStrings["push.action.distributors"]).closest("a")?.getAttribute("href")).toBe(
      "https://unifiedpush.org/users/distributors/",
    );
  });

  it("offers the off switch and machine mutes only on registered rows", () => {
    const { events } = setup({ rows: [{ orgId: "o", orgName: "O", state: { kind: "active" }, machines: [{ id: MACHINE, name: "build-box", muted: false }] }] });
    fireEvent.click(screen.getByText(pushStrings["push.action.turn_off"]));
    fireEvent.click(screen.getByText(pushStrings["push.action.mute_hour"]));
    fireEvent.click(screen.getByLabelText("build-box"));
    expect(events).toEqual(["off:o", "mute-hour:o", `machine:o:${MACHINE}:true`]);
  });

  it("wires the row action and hides controls an unregistered row cannot use", () => {
    const { events } = setup({ rows: [{ orgId: "o", orgName: "O", state: { kind: "needs_permission" }, machines: [] }] });
    expect(screen.queryByText(pushStrings["push.action.turn_off"])).toBeNull();
    fireEvent.click(screen.getByText(pushStrings["push.action.allow"]));
    expect(events).toEqual(["allow:o"]);
  });

  it("shows the distributor picker when there is a choice", () => {
    const { events } = setup({
      rows: [],
      distributors: { distributors: ["io.heckel.ntfy", "com.example.yaran"], selected: "io.heckel.ntfy", embedded: "com.example.yaran" },
    });
    expect(screen.getByText(pushStrings["push.distributor.embedded"])).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "com.example.yaran" } });
    expect(events).toEqual(["distributor:com.example.yaran"]);
  });
});
