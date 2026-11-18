/**
 * The shell's one way into a machine: resolve the host, validate the route, open the window.
 *
 * A host never comes from a deep link or a push payload. An org machine's `{orgId, machineId}`
 * is looked up in the last authenticated machines list (`machinesStore`); a direct machine is
 * looked up by its stored record, and its org routes are re-resolved against the current org
 * lists (a route through an org this phone left, or a machine its list no longer has, is
 * dropped). Anything unknown is refused. `closedDestination` turns the window's `closed` event
 * into the shell screen to show.
 *
 * - A direct machine with several routes opens as `kind: "routes"` with its instance; native
 *   probes each route on its own and never lets one host's session reach another.
 * - `shareBatch` hands that one held share to the window (G5): native refuses with `no_share`
 *   when none is held and `share_changed` when a newer share replaced it, consuming nothing.
 * - An `instance_changed` close is tied to a record only by the event's own `host` and
 *   `requestedHost`, never by which machine the shell opened last.
 * - The lists, the direct records and `MachineView.open` are injectable; defaults are live.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/openMachine.ts
 * ├── @yaran/machine-view:src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/knownHosts.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * └── src/lib/orgStore.ts
 * External: @lingui/core
 *
 * Used by:
 * src/lib/openMachine.ts
 * ├── src/App.tsx
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/openMachine.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/DirectCheck.tsx
 * ├── src/screens/machines/DirectSection.tsx
 * ├── src/screens/machines/InstanceChangedDialog.tsx
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/instanceChanged.test.tsx
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/onboarding.test.tsx
 * ├── src/screens/settings/LockScreen.tsx
 * ├── src/screens/settings/SecuritySettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { agentRoute, assertNever, isAgentRoute, type ClosedEvent, type MachineRoute, type MachineViewPlugin } from '@yaran/machine-view';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { MachineSummary } from '@yaran/protocol';

import { directStore, type DirectRecord } from './directStore.ts';
import { isOrgHost } from './knownHosts.ts';
import { machinesStore } from './machinesStore.ts';
import { MachineView } from './native/machineView.ts';
import { orgStore } from './orgStore.ts';

export interface OpenMachineDeps {
  /** The org's machines from the last authenticated `GET /v1/me/machines`, or undefined if never loaded. */
  machines(orgId: string): readonly Pick<MachineSummary, 'id' | 'hostname'>[] | undefined;
  /** Whether the org is still added on this phone. */
  orgKnown(orgId: string): boolean;
  /** Whether an org control plane or org machine claims the host (the known-host guard). */
  orgHost(host: string): boolean;
  direct(id: string): DirectRecord | undefined;
  machineView: Pick<MachineViewPlugin, 'open'>;
}

const live: OpenMachineDeps = {
  machines: (orgId) => machinesStore.get()[orgId]?.machines,
  orgKnown: (orgId) => orgStore.get().orgs.some((o) => o.id === orgId),
  orgHost: isOrgHost,
  direct: (id) => directStore.get().machines.find((m) => m.id === id),
  machineView: { open: (options) => MachineView.open(options) },
};

export interface OpenTarget {
  /** `#/agent/<sid>[/tab/<id>]`; anything else is refused. */
  route?: string;
  /** Hand the held share to the window, only if it is still this batch (the one on screen). */
  shareBatch?: string;
}

export type OpenMachineResult =
  | { ok: true }
  | { ok: false; reason: 'unknown_machine' | 'bad_route' | 'host_conflict' }
  | { ok: false; reason: 'native_refused'; code: string };

// Opens a person asked for (a tap on a machine), counted at the tap: an automatic reopen that
// began before one gives way to it, even while the choice is still being remembered.
let chosen = 0;
export function choseMachine(): void {
  chosen += 1;
}
export const machineChoices = (): number => chosen;

// A Capacitor rejection's code, kept only when it is a safe token (it reaches a toast and the log).
export function rejectionCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : undefined;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unknown';
}

function extras(target: OpenTarget): OpenTarget {
  return { ...(target.route === undefined ? {} : { route: target.route }), ...(target.shareBatch === undefined ? {} : { shareBatch: target.shareBatch }) };
}

async function nativeOpen(deps: OpenMachineDeps, options: Parameters<MachineViewPlugin['open']>[0]): Promise<OpenMachineResult> {
  try {
    await deps.machineView.open(options);
  } catch (err) {
    // The native window refused to start: say so instead of leaving the tap without an answer.
    return { ok: false, reason: 'native_refused', code: rejectionCode(err) };
  }
  return { ok: true };
}

export async function openMachine(orgId: string, machineId: string, target: OpenTarget = {}, deps: OpenMachineDeps = live): Promise<OpenMachineResult> {
  const machine = deps.machines(orgId)?.find((m) => m.id === machineId);
  if (!machine) return { ok: false, reason: 'unknown_machine' };
  if (target.route !== undefined && !isAgentRoute(target.route)) return { ok: false, reason: 'bad_route' };
  return nativeOpen(deps, { orgId, machineId, host: machine.hostname, ...extras(target) });
}

/** Two routes name the same way to reach a machine: the same org machine, or the same direct host. */
function sameRoute(a: MachineRoute, b: MachineRoute): boolean {
  return a.kind === 'org' ? b.kind === 'org' && a.orgId === b.orgId && a.machineId === b.machineId : b.kind === 'direct' && a.host === b.host;
}

/** `route` as `record` reaches it right now (an org route re-resolved), or undefined when it is gone. */
export function currentRoute(record: DirectRecord, route: MachineRoute, deps: Pick<OpenMachineDeps, 'machines' | 'orgKnown'> = live): MachineRoute | undefined {
  return liveRoutes(record, deps).find((r) => sameRoute(r, route));
}

/** The routes to hand native now: org routes re-resolved, stale ones dropped, the user's order kept. */
export function liveRoutes(record: DirectRecord, deps: Pick<OpenMachineDeps, 'machines' | 'orgKnown'> = live): MachineRoute[] {
  const out: MachineRoute[] = [];
  for (const r of record.routes) {
    if (r.kind === 'direct') {
      out.push(r);
      continue;
    }
    if (!deps.orgKnown(r.orgId)) continue;
    const list = deps.machines(r.orgId);
    const m = list?.find((x) => x.id === r.machineId);
    // An unloaded list keeps the host recorded when the user approved the route; native signs it in on its own.
    if (list === undefined) out.push(r);
    else if (m) out.push({ ...r, host: m.hostname });
  }
  return out;
}

export async function openDirect(id: string, target: OpenTarget = {}, deps: OpenMachineDeps = live): Promise<OpenMachineResult> {
  const record = deps.direct(id);
  if (!record) return { ok: false, reason: 'unknown_machine' };
  if (target.route !== undefined && !isAgentRoute(target.route)) return { ok: false, reason: 'bad_route' };
  // A direct host that an org now claims must not load: the org's sign-out would wipe it.
  const routes = liveRoutes(record, deps).filter((r) => r.kind === 'org' || !deps.orgHost(r.host));
  if (!routes.some((r) => r.kind === 'direct' && r.host === record.host)) return { ok: false, reason: 'host_conflict' };
  const options =
    routes.length > 1 && record.instance !== null
      ? { kind: 'routes' as const, routes, instance: record.instance, ...extras(target) }
      : { kind: 'direct' as const, host: record.host, ...(record.instance === null ? {} : { instance: record.instance }), ...extras(target) };
  return nativeOpen(deps, options);
}

/**
 * The one direct record an `instance_changed` close is about, from the window's own context:
 * `requestedHost` (what the open named) and `host` (what answered as another machine) must both
 * be addresses of the same record, and of exactly one. Anything less is null: the caller then
 * must not offer to remove anything.
 */
/** A record, the route that answered as another machine, and the identity the record had then. */
export interface ChangedTarget {
  id: string;
  route: MachineRoute;
  instance: string | null;
}

export function instanceChangedTarget(
  event: ClosedEvent,
  machines: readonly DirectRecord[],
  deps: Pick<OpenMachineDeps, 'machines' | 'orgKnown'> = live,
): ChangedTarget | null {
  const { host, requestedHost } = event;
  if (!host || !requestedHost) return null;
  const hits = machines.flatMap((m) => {
    const routes = [...m.routes, ...liveRoutes(m, deps)];
    const answered = routes.find((r) => r.host === host);
    return answered && routes.some((r) => r.host === requestedHost) ? [{ id: m.id, route: answered, instance: m.instance }] : [];
  });
  return hits.length === 1 ? hits[0]! : null;
}

/** Opens a machine at an agent, or at one of its tabs (the notification tap, a verified link). */
export function openAgent(orgId: string, machineId: string, sid: string, tabId?: string, deps: OpenMachineDeps = live): Promise<OpenMachineResult> {
  let route: string;
  try {
    route = agentRoute(sid, tabId);
  } catch {
    return Promise.resolve({ ok: false, reason: 'bad_route' });
  }
  return openMachine(orgId, machineId, { route }, deps);
}

/** One sentence per refusal, for the toast a tap on Open raises. */
export function openFailureMessage(result: Exclude<OpenMachineResult, { ok: true }>): MessageDescriptor {
  switch (result.reason) {
    case 'unknown_machine':
      return msg`That machine isn't in this org's list any more. Refresh the list and try again.`;
    case 'bad_route':
      return msg`That link points somewhere the app can't open.`;
    case 'host_conflict':
      return msg`An org on this phone now lists that address, so it can't also open as a direct machine. Remove the direct machine and open it from its org.`;
    case 'native_refused': {
      const code = result.code;
      return msg`The app couldn't open the machine window (${code}). Try again; if it keeps happening, send diagnostics from Settings.`;
    }
    default:
      return assertNever(result);
  }
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
