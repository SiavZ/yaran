/**
 * The shell's one way into a machine: resolve the host, validate the route, open the window.
 *
 * A host never comes from a deep link or a push payload: `{orgId, machineId}` is looked up in
 * the last authenticated machines list (Phase 14's store), and an unknown machine is refused.
 * `openAgent` is what Phase 16's notification tap calls. `closedDestination` turns the
 * window's `closed` event into the shell screen to show.
 *
 * - Pure apart from the injected `MachineView.open`; the machines list is injected too.
 *
 * <module-headers:begin>
 * Uses:
 * src/openMachine.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/definitions.ts
 * ├── src/outcomes.ts
 * └── src/routes.ts
 * External: none
 *
 * Used by:
 * src/openMachine.ts
 * ├── src/index.ts
 * └── test/openMachine.test.ts
 * <module-headers:end>
 */
import type { MachineSummary } from "@yaran/protocol";
import type { MachineViewPlugin } from "./definitions.ts";
import { assertNever, type ClosedEvent } from "./outcomes.ts";
import { agentRoute, isAgentRoute } from "./routes.ts";

export interface OpenMachineDeps {
  /** The org's machines from the last authenticated `GET /v1/machines`, or undefined if never loaded. */
  machines(orgId: string): readonly Pick<MachineSummary, "id" | "hostname">[] | undefined;
  machineView: Pick<MachineViewPlugin, "open">;
}

export type OpenMachineResult = { ok: true } | { ok: false; reason: "unknown_machine" | "bad_route" };

export async function openMachine(
  deps: OpenMachineDeps,
  orgId: string,
  machineId: string,
  route?: string,
): Promise<OpenMachineResult> {
  const machine = deps.machines(orgId)?.find((m) => m.id === machineId);
  if (!machine) return { ok: false, reason: "unknown_machine" };
  if (route !== undefined && !isAgentRoute(route)) return { ok: false, reason: "bad_route" };
  await deps.machineView.open({ orgId, machineId, host: machine.hostname, ...(route === undefined ? {} : { route }) });
  return { ok: true };
}

/** Phase 16's notification tap: opens the machine at an agent, or at one of its tabs. */
export function openAgent(
  deps: OpenMachineDeps,
  orgId: string,
  machineId: string,
  sid: string,
  tabId?: string,
): Promise<OpenMachineResult> {
  let route: string;
  try {
    route = agentRoute(sid, tabId);
  } catch {
    return Promise.resolve({ ok: false, reason: "bad_route" });
  }
  return openMachine(deps, orgId, machineId, route);
}

/** The shell screen to show after the machine window closed. */
export type ShellDestination = "machines" | "settings" | "org_sign_in";

export function closedDestination(event: ClosedEvent): ShellDestination {
  switch (event.reason) {
    case "user":
    case "home":
    case "error":
      return "machines";
    case "settings":
      return "settings";
    case "signedOut":
      return "org_sign_in";
    default:
      return assertNever(event.reason);
  }
}
