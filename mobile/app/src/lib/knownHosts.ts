/**
 * The known-host guard: one host is never two things on this phone.
 *
 * An org sign-out wipes a host's web data and cookies, so a host shared by an org machine and
 * a direct machine would sign the other out. This module answers, from what the shell knows
 * (org control planes, the org machine lists, the direct records), who already owns a host.
 * Native is the second authority: a host with an org session record is refused there with
 * `org_host`, which covers an org list that could not be loaded.
 *
 * - Exact, lowercase host comparison; no suffix or pattern matching.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/knownHosts.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * └── src/lib/orgStore.ts
 * External: none
 *
 * Used by:
 * src/lib/knownHosts.ts
 * ├── src/lib/directStore.test.ts
 * ├── src/lib/openMachine.ts
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * └── src/screens/onboarding/ConfirmMachine.tsx
 * <module-headers:end>
 */
import { directStore } from './directStore.ts';
import { machinesStore, refreshMachines } from './machinesStore.ts';
import { orgStore } from './orgStore.ts';

export type HostOwner = { kind: 'org'; name: string } | { kind: 'direct'; label: string };

/** True when `host` is an org's control plane or one of its listed machines. */
export function isOrgHost(host: string): boolean {
  return orgOwner(host) !== null;
}

function orgOwner(host: string): HostOwner | null {
  const lists = machinesStore.get();
  for (const org of orgStore.get().orgs) {
    if (new URL(org.id).hostname === host || (lists[org.id]?.machines ?? []).some((m) => m.hostname === host)) {
      return { kind: 'org', name: org.name };
    }
  }
  return null;
}

/** Who already owns `host` on this phone, or null when nobody does. */
export function hostOwner(host: string): HostOwner | null {
  const org = orgOwner(host);
  if (org) return org;
  const direct = directStore.get().machines.find((m) => m.routes.some((r) => r.host === host));
  return direct ? { kind: 'direct', label: direct.label } : null;
}

/** True when an org machine is already a route of some direct machine. */
export function orgRouteTaken(orgId: string, machineId: string): boolean {
  return directStore.get().machines.some((m) => m.routes.some((r) => r.kind === 'org' && r.orgId === orgId && r.machineId === machineId));
}

/** Loads every org list that has never answered, so the guard sees their hosts. */
export async function loadOrgLists(): Promise<void> {
  const lists = machinesStore.get();
  const cold = orgStore.get().orgs.filter((o) => lists[o.id]?.state !== 'ready' && !lists[o.id]?.machines.length);
  await Promise.all(cold.map((o) => refreshMachines(o.id)));
}
