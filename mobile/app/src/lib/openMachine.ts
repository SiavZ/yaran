/**
 * The shell's one way into a machine: resolve the host, validate the route, open the window.
 *
 * A host never comes from a deep link or a push payload: `{orgId, machineId}` is looked up in
 * the last authenticated machines list (`machinesStore`), and an unknown machine is refused.
 * `openAgent` is what Phase 16's notification tap calls. `closedDestination` turns the
 * window's `closed` event into the shell screen to show.
 *
 * - The machines list and `MachineView.open` are injectable; the defaults are the live ones.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/openMachine.ts
 * ├── @yaran/machine-view:src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/machinesStore.ts
 * └── src/lib/native/machineView.ts
 * External: none
 *
 * Used by:
 * src/lib/openMachine.ts
 * ├── src/App.tsx
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/openMachine.test.ts
 * ├── src/push/pushWiring.ts
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { agentRoute, assertNever, isAgentRoute, type ClosedEvent, type MachineViewPlugin } from '@yaran/machine-view';
import type { MachineSummary } from '@yaran/protocol';

import { machinesStore } from './machinesStore.ts';
import { MachineView } from './native/machineView.ts';

export interface OpenMachineDeps {
  /** The org's machines from the last authenticated `GET /v1/me/machines`, or undefined if never loaded. */
  machines(orgId: string): readonly Pick<MachineSummary, 'id' | 'hostname'>[] | undefined;
  machineView: Pick<MachineViewPlugin, 'open'>;
}

const live: OpenMachineDeps = {
  machines: (orgId) => machinesStore.get()[orgId]?.machines,
  machineView: { open: (options) => MachineView.open(options) },
};

export type OpenMachineResult = { ok: true } | { ok: false; reason: 'unknown_machine' | 'bad_route' };

export async function openMachine(orgId: string, machineId: string, route?: string, deps: OpenMachineDeps = live): Promise<OpenMachineResult> {
  const machine = deps.machines(orgId)?.find((m) => m.id === machineId);
  if (!machine) return { ok: false, reason: 'unknown_machine' };
  if (route !== undefined && !isAgentRoute(route)) return { ok: false, reason: 'bad_route' };
  await deps.machineView.open({ orgId, machineId, host: machine.hostname, ...(route === undefined ? {} : { route }) });
  return { ok: true };
}

/** Phase 16's notification tap: opens the machine at an agent, or at one of its tabs. */
export function openAgent(orgId: string, machineId: string, sid: string, tabId?: string, deps: OpenMachineDeps = live): Promise<OpenMachineResult> {
  let route: string;
  try {
    route = agentRoute(sid, tabId);
  } catch {
    return Promise.resolve({ ok: false, reason: 'bad_route' });
  }
  return openMachine(orgId, machineId, route, deps);
}

/** The shell screen to show after the machine window closed. */
export type ShellDestination = 'machines' | 'settings' | 'org_sign_in';

export function closedDestination(event: ClosedEvent): ShellDestination {
  switch (event.reason) {
    case 'user':
    case 'home':
    case 'error':
      return 'machines';
    case 'settings':
      return 'settings';
    case 'signedOut':
      return 'org_sign_in';
    default:
      return assertNever(event.reason);
  }
}
