/**
 * Push orchestration bound to the shell: reconcile per org, the native listeners, the
 * notification tap, and the Settings section's actions.
 *
 * The pure decisions live in `pushRegistration.ts`, `pushPermission.ts` and
 * `notificationTap.ts`; this module feeds them the org list, the authenticated machines list,
 * Phase 15's `openMachine` and the shell's toasts, and records each answer in `pushStore`.
 *
 * - A tap is resolved against the machines list only (refreshed first on a cold start), never
 *   a host from the payload.
 * - `device_revoked` anywhere removes the org from this phone, as the machine list does.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushWiring.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/notificationTap.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushPermission.ts
 * ├── src/push/pushRegistration.ts
 * └── src/push/pushStrings.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/push/pushWiring.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/push/pushWiring.test.ts
 * └── src/screens/settings/NotificationSettings.tsx
 * <module-headers:end>
 */
import { Capacitor } from '@capacitor/core';
import type { Device, DevicePatch } from '@yaran/protocol';
import { Push } from '@yaran/push';

import { log } from '../lib/diagnostics.ts';
import { machinesStore, refreshMachines } from '../lib/machinesStore.ts';
import { Session } from '../lib/native/machineView.ts';
import { notify } from '../lib/notify.ts';
import { openMachine } from '../lib/openMachine.ts';
import { findOrg, handleDeviceRevoked, orgStore, type OrgRecord } from '../lib/orgStore.ts';
import { navigate } from '../lib/route.ts';
import { settingsStore } from '../lib/settingsStore.ts';
import { handleTap, type TapDeps } from './notificationTap.ts';
import { pushDeps, pushStore } from './pushDeps.ts';
import { turnOnPermission, type RowAction } from './pushPermission.ts';
import { drainPending, muteMachine, MuteSync, mutesOf, reconcileOrg, registerOrg, turnOffOrg, type PushOrg, type ReconcileResult } from './pushRegistration.ts';
import { DISTRIBUTORS_URL, pushText } from './pushStrings.ts';

export const muteSync = new MuteSync();

// shortcut: the device row's label is the platform, not the model; native DeviceLabel could replace it.
const deviceLabel = () => (Capacitor.getPlatform() === 'ios' ? 'yaran on iOS' : 'yaran on Android');

async function pushOrgOf(org: OrgRecord): Promise<PushOrg> {
  const { installId } = await Session.installId({ orgId: org.id });
  const machines = (machinesStore.get()[org.id]?.machines ?? []).map((m) => ({ id: m.id, name: m.name }));
  return { orgId: org.id, orgUrl: org.id, orgName: org.name, installId, label: deviceLabel(), locale: settingsStore.get().locale, machines };
}

async function record(org: OrgRecord, result: ReconcileResult): Promise<void> {
  pushStore.update((s) => ({ ...s, [org.id]: result }));
  if (result.kind !== 'revoked') return;
  notify('warning', pushText('push.toast.revoked', { name: org.name }));
  await handleDeviceRevoked(org.id);
}

async function guarded(what: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (err) {
    log('warn', `push ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function reconcilePush(org: OrgRecord): Promise<void> {
  return guarded('reconcile', async () => record(org, await reconcileOrg(pushDeps, await pushOrgOf(org), muteSync)));
}

/** Every foreground (14's resume hook) and on opening Settings. */
export function reconcileAllPush(): void {
  for (const org of orgStore.get().orgs) void reconcilePush(org);
}

function drainAll(): Promise<void> {
  return guarded('drain', async () => {
    const orgs = orgStore.get().orgs;
    const done = await drainPending(pushDeps, await Promise.all(orgs.map(pushOrgOf)), muteSync);
    for (const org of orgs) {
      const result = done.get(org.id);
      if (result) await record(org, result);
    }
  });
}

function deviceOf(orgId: string): Device | null {
  const last = pushStore.get()[orgId];
  return last?.kind === 'row' ? last.device : null;
}

async function patchMutes(orgId: string, patch: DevicePatch): Promise<void> {
  const org = findOrg(orgId);
  const device = deviceOf(orgId);
  if (!org || !device) return;
  const out = await muteSync.apply(pushDeps, orgId, device, patch);
  if (out === 'offline') notify('info', pushText('push.toast.mute_saved_offline', { name: org.name }));
  else if (out === 'failed') notify('error', pushText('push.row.registration_failed'));
  await reconcilePush(org);
}

const tapDeps: TapDeps = {
  push: Push,
  pairedMachineIds: (orgId) => (machinesStore.get()[orgId]?.machines ?? []).map((m) => m.id),
  openAgent: async ({ orgId, machineId, route }) => {
    const opened = await openMachine(orgId, machineId, route);
    if (!opened.ok) log('warn', `notification tap did not open a machine: ${opened.reason}`);
  },
  showMachines: () => navigate({ name: 'machines' }),
  muteMachine: async (orgId, machineId) => {
    const device = deviceOf(orgId);
    const name = machinesStore.get()[orgId]?.machines.find((m) => m.id === machineId)?.name ?? machineId;
    const out = device ? await muteMachine(pushDeps, muteSync, orgId, device, machineId) : 'failed';
    if (out === 'saved' || out === 'unchanged') notify('success', pushText('push.toast.machine_muted', { name }));
    else if (out === 'offline') notify('info', pushText('push.toast.mute_saved_offline', { name }));
    else notify('error', pushText('push.row.registration_failed'));
  },
  toast: (key) => notify('info', pushText(key)),
};

/** Installs the native push listeners and drains registrations queued while the shell was down. */
export async function installPush(): Promise<() => void> {
  const handles = await Promise.all([
    Push.addListener('notificationTapped', (event) => {
      void guarded('tap', async () => {
        if (!machinesStore.get()[event.orgId]?.machines.length) await refreshMachines(event.orgId);
        await handleTap(tapDeps, event);
      });
    }),
    // A distributor change (no org) moves every org's endpoint.
    Push.addListener('endpointChanged', ({ orgId }) => {
      const org = orgId === null ? undefined : findOrg(orgId);
      if (org) void reconcilePush(org);
      else if (orgId === null) reconcileAllPush();
    }),
    Push.addListener('pendingRegistrations', () => void drainAll()),
  ]);
  void drainAll();
  return () => handles.forEach((h) => void h.remove());
}

// The explicit "Turn on" step: never at launch, only from the row's button.
async function turnOn(org: OrgRecord): Promise<void> {
  const granted = await turnOnPermission(Push, {
    showRationale: async () => (notify('info', pushText('push.rationale')), true),
    offerSettings: async () => true,
  });
  if (granted !== 'granted') return;
  const device = deviceOf(org.id);
  const mutes = device ? mutesOf(device) : { mute_all: false, muted_until: null, muted_machine_ids: [] };
  await record(org, await registerOrg(pushDeps, await pushOrgOf(org), await pushDeps.session.meta({ orgUrl: org.id }), mutes));
}

export function pushAction(orgId: string, action: Exclude<RowAction, null>): Promise<void> {
  const org = findOrg(orgId);
  if (!org) return Promise.resolve();
  return guarded(action, async () => {
    switch (action) {
      case 'turn_on':
      case 'allow':
        return turnOn(org);
      case 'open_settings':
        return Push.openNotificationSettings();
      case 'distributors':
        window.open(DISTRIBUTORS_URL, '_blank', 'noopener');
        return;
      case 'retry':
        return reconcilePush(org);
      case 'unmute':
        return patchMutes(orgId, { mute_all: false, muted_until: null });
    }
  });
}

export function turnOffPush(org: OrgRecord): Promise<void> {
  return guarded('turn off', async () => {
    const meta = await pushDeps.session.meta({ orgUrl: org.id });
    await record(org, await turnOffOrg(pushDeps, await pushOrgOf(org), meta, deviceOf(org.id)));
    notify('success', pushText('push.toast.turned_off', { name: org.name }));
  });
}

export function mutePushOrg(orgId: string, mode: 'hour' | 'forever'): Promise<void> {
  const patch: DevicePatch = mode === 'hour' ? { muted_until: new Date(Date.now() + 3_600_000).toISOString() } : { mute_all: true };
  return guarded('mute', () => patchMutes(orgId, patch));
}

export function mutePushMachine(orgId: string, machineId: string, muted: boolean): Promise<void> {
  const ids = deviceOf(orgId)?.muted_machine_ids ?? [];
  const next = muted ? [...new Set([...ids, machineId])] : ids.filter((id) => id !== machineId);
  return guarded('mute machine', () => patchMutes(orgId, { muted_machine_ids: next }));
}

export function selectDistributor(distributor: string): Promise<void> {
  return guarded('distributor', async () => {
    await Push.selectDistributor({ distributor });
    reconcileAllPush();
  });
}
