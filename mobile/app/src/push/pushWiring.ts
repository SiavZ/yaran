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
 * ├── src/lib/erasure.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/muteSync.ts
 * ├── src/push/notificationTap.ts
 * ├── src/push/pushDeps.ts
 * ├── src/push/pushPermission.ts
 * ├── src/push/pushRegistration.ts
 * └── src/push/pushStrings.ts
 * External: @capacitor/core, @lingui/core
 *
 * Used by:
 * src/push/pushWiring.ts
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/lib/lifecycle.ts
 * ├── src/push/pushRaces.test.ts
 * ├── src/push/pushRejections.test.ts
 * ├── src/push/pushToggles.test.ts
 * ├── src/push/pushTurns.test.ts
 * ├── src/push/pushWiring.test.ts
 * └── src/screens/settings/NotificationSettings.tsx
 * <module-headers:end>
 */
import { Capacitor } from '@capacitor/core';
import { i18n } from '@lingui/core';
import type { Device, DevicePatch } from '@yaran/protocol';
import { isNotificationTappedEvent, Push } from '@yaran/push';

import { log } from '../lib/diagnostics.ts';
import { machinesStore, refreshMachines } from '../lib/machinesStore.ts';
import { Session } from '../lib/native/machineView.ts';
import { notify } from '../lib/notify.ts';
import { choseMachine, machineChoices, openFailureMessage, openMachine, rejectionCode } from '../lib/openMachine.ts';
import { eraseEpoch, erasing } from '../lib/erasure.ts';
import { findOrg, handleDeviceRevoked, orgIncarnation, orgStore, type OrgRecord } from '../lib/orgStore.ts';
import { navigate } from '../lib/route.ts';
import { settingsStore } from '../lib/settingsStore.ts';
import { handleTap, type TapDeps } from './notificationTap.ts';
import { muteSync, pushStore, scopedPushDeps, StalePushOrg } from './pushDeps.ts';
import { turnOnPermission, type RowAction } from './pushPermission.ts';
import { machineMute, type MuteChange, type MuteOutcome } from './muteSync.ts';
import { currentDevice, drainPending, failureReason, reconcileOrg, registerOrg, type PushOrg, type ReconcileResult } from './pushRegistration.ts';
import { DISTRIBUTORS_URL, pushText } from './pushStrings.ts';

export { muteSync };

// shortcut: the device row's label is the platform, not the model; native DeviceLabel could replace it.
const deviceLabel = () => (Capacitor.getPlatform() === 'ios' ? 'yaran on iOS' : 'yaran on Android');

/** Which org a piece of push work is for: its incarnation, and the erase epoch when the work began. */
interface Ticket {
  id: string;
  inc: number | undefined;
  epoch: number;
}
const ticketFor = (orgId: string): Ticket => ({ id: orgId, inc: orgIncarnation(orgId), epoch: eraseEpoch() });
/**
 * Still that org: not removed, no erase started since (an erase may re-add it as another
 * incarnation), and none running now. Ordinary push work, a ticket taken during an erase
 * included, never runs while one is erasing; the erase does its own unregister.
 */
const valid = (t: Ticket) => t.inc !== undefined && orgIncarnation(t.id) === t.inc && eraseEpoch() === t.epoch && !erasing();
/** Push deps for one ticket (and, for a notification, the installation's own lifetime): every native or org call checks first. */
const depsFor = (t: Ticket, alive: () => boolean = () => true) => scopedPushDeps(() => alive() && valid(t));

// `Session.installId` mints the org's install id and device key on first use: never for stale work.
// `alive` is the lifetime of whatever started this (the push installation, the shell): it ends the work too.
async function pushOrgOf(org: OrgRecord, t: Ticket, alive: () => boolean = () => true): Promise<PushOrg> {
  if (!valid(t) || !alive()) throw new StalePushOrg();
  const { installId } = await Session.installId({ orgId: org.id });
  if (!valid(t) || !alive()) throw new StalePushOrg();
  const machines = (machinesStore.get()[org.id]?.machines ?? []).map((m) => ({ id: m.id, name: m.name }));
  return { orgId: org.id, orgUrl: org.id, orgName: org.name, installId, label: deviceLabel(), locale: settingsStore.get().locale, machines };
}

/**
 * Records an answer for incarnation `inc` of an org. An answer for an org removed (or erased)
 * and added again meanwhile is about a device row that no longer exists here: it is dropped,
 * never shown, and never removes the new org.
 */
async function record(org: OrgRecord, result: ReconcileResult, t: Ticket): Promise<void> {
  if (!valid(t)) return;
  pushStore.update((s) => ({ ...s, [org.id]: result }));
  if (result.kind !== 'revoked') return;
  if (await handleDeviceRevoked(org.id, t.inc)) notify('warning', pushText('push.toast.revoked', { name: org.name }));
}

async function guarded(what: string, job: () => Promise<void>): Promise<void> {
  try {
    await job();
  } catch (err) {
    // The org was removed (or erased and added again) while this ran: nothing of the new one was touched.
    if (err instanceof StalePushOrg) return;
    log('warn', `push ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}


/** `alive` is the lifetime of what asked (the push installation, the shell); it ends the reconcile too. */
export function reconcilePush(org: OrgRecord, alive: () => boolean = () => true): Promise<void> {
  const t = ticketFor(org.id);
  // Recorded in the org's turn: a Turn off or mute queued behind it records after it.
  return guarded('reconcile', async () => void (await reconcileOrg(depsFor(t, alive), await pushOrgOf(org, t, alive), muteSync, (r) => record(org, r, t))));
}

/** Every foreground (14's resume hook) and on opening Settings. */
export function reconcileAllPush(alive: () => boolean = () => true): void {
  for (const org of orgStore.get().orgs) void reconcilePush(org, alive);
}

// The installation's lifetime (`alive`) rides every step, from the native drain through the
// install id to the registration and its publication: a drain outliving it does nothing.
function drainAll(alive: () => boolean): Promise<void> {
  return guarded('drain', async () => {
    const orgs = orgStore.get().orgs;
    const tickets = new Map(orgs.map((o) => [o.id, ticketFor(o.id)]));
    const ticket = (id: string) => tickets.get(id)!;
    // An org gone stale meanwhile is left out rather than failing the others.
    const pushOrgs = await Promise.all(orgs.map((o) => pushOrgOf(o, ticket(o.id), alive).catch((err: unknown) => (err instanceof StalePushOrg ? null : Promise.reject(err)))));
    const byId = new Map(orgs.map((o) => [o.id, o]));
    await drainPending(scopedPushDeps(alive), pushOrgs.filter((o) => o !== null), muteSync, (id) => depsFor(ticket(id), alive), (id, r) => record(byId.get(id)!, r, ticket(id)));
  });
}

function deviceOf(orgId: string): Device | null {
  const last = pushStore.get()[orgId];
  return last?.kind === 'row' ? last.device : null;
}

/**
 * The org's device row: the one the last reconcile recorded, else fetched now for this ticket
 * (a cold notification can arrive before any reconcile ran). It never registers or asks for a
 * permission: no row means there is nothing to mute.
 */
// Inside the org's turn only (see `MuteSync.applyTo`): a fetched device is then the newest one.
async function deviceFor(t: Ticket, alive: () => boolean = () => true): Promise<Device | null | 'revoked'> {
  const cached = deviceOf(t.id);
  if (cached) return cached;
  const deps = depsFor(t, alive);
  const listed = await currentDevice(deps, t.id);
  if (!alive() || !valid(t)) throw new StalePushOrg();
  if (listed === 'revoked') {
    // The native session is already gone; its push keys go too, as a reconcile's revocation does.
    await deps.push.forgetOrg({ orgId: t.id });
    return 'revoked';
  }
  return listed !== null && typeof listed === 'object' && 'id' in listed ? muteSync.taken(deps, t.id, listed) : null;
}

/** This phone was removed from the org: the one ticket-fenced clean-up every path shares. */
async function revoked(orgId: string, t: Ticket): Promise<void> {
  const org = findOrg(orgId);
  if (org) await record(org, { kind: 'revoked' }, t);
}

/** The toast for a mute outcome that did not simply save; `name` is the org or machine. */
function muteToast(out: MuteOutcome | Device, name: string): void {
  if (out === 'offline') notify('info', pushText('push.toast.mute_saved_offline', { name }));
  else if (out === 'full') notify('error', pushText('push.toast.mute_full', { name }));
  else if (out === 'failed') notify('error', pushText('push.row.registration_failed'));
}

/** Applies a mute change, decided in the org's turn against the mutes in force then. */
async function patchMutes(orgId: string, change: MuteChange): Promise<void> {
  const org = findOrg(orgId);
  if (!org) return;
  const t = ticketFor(orgId);
  // The lookup runs in the change's own turn: a later change waits for this one.
  const out = await muteSync.applyTo(depsFor(t), orgId, () => deviceFor(t), change);
  if (!valid(t)) return;
  if (out === 'revoked') return revoked(orgId, t);
  if (out === null) return notify('error', pushText('push.row.registration_failed'));
  muteToast(out, org.name);
  await reconcilePush(org);
}

/**
 * The handlers for one notification tap, bound to the org as it was when the tap arrived (`t`,
 * taken before any refresh): an org removed, or erased and added again, while the tap waited is
 * another org, and the tap neither opens nor mutes anything of it. The alert stays then.
 */
function tapDepsFor(t: Ticket, installed: () => boolean, owned: () => boolean = installed): TapDeps {
  // The tap's org is still that one, and the push wiring that received it is still installed.
  const ok = () => installed() && valid(t);
  const stale = () => {
    log('warn', 'a notification tap was for an org that changed while it waited');
    notify('info', pushText('push.toast.machine_unpaired'));
    navigate({ name: 'machines' });
  };
  return {
    push: depsFor(t, installed).push,
    pairedMachineIds: (orgId) => (orgId === t.id && ok() ? (machinesStore.get()[orgId]?.machines ?? []).map((m) => m.id) : []),
    openAgent: async ({ orgId, machineId, route }) => {
      // The last check before the native open: still installed, and nothing newer chosen.
      if (!owned()) return false;
      if (orgId !== t.id || !valid(t)) return (stale(), false);
      const opened = await openMachine(orgId, machineId, { route });
      // A native open already submitted cannot be taken back; nothing after it runs once uninstalled.
      if (!installed()) return false;
      if (opened.ok) return true;
      log('warn', `notification tap did not open a machine: ${opened.reason}${opened.reason === 'native_refused' ? ` (${opened.code})` : ''}`);
      notify('error', i18n._(openFailureMessage(opened)));
      return false;
    },
    showMachines: () => navigate({ name: 'machines' }),
    muteMachine: async (orgId, machineId) => {
      if (!installed()) return;
      if (orgId !== t.id || !valid(t)) return stale();
      const name = machinesStore.get()[orgId]?.machines.find((m) => m.id === machineId)?.name ?? machineId;
      // The org's turn is taken now, before the cold lookup: a change made after this tap lands after it.
      const r = await muteSync.applyTo(depsFor(t, installed), orgId, () => deviceFor(t, installed), machineMute(machineId, true));
      const out = r === null ? 'failed' : typeof r === 'object' ? 'saved' : r;
      if (!ok()) return;
      if (out === 'revoked') return revoked(orgId, t);
      if (out === 'saved' || out === 'unchanged') notify('success', pushText('push.toast.machine_muted', { name }));
      else muteToast(out, name);
    },
    toast: (key) => notify('info', pushText(key)),
  };
}

/**
 * Installs the native push listeners and drains registrations queued while the shell was down.
 * `mounted` is the caller's lifetime: once it, or the returned removal, ends, no notification
 * work goes further, a tap still waiting on a refresh or an open included.
 */
export async function installPush(mounted: () => boolean = () => true): Promise<() => void> {
  let removed = false;
  const installed = () => !removed && mounted();
  const handles = await Promise.all([
    Push.addListener('notificationTapped', (event) => {
      // Which org this tap is for, taken now, before the cold-start refresh can wait out an erase.
      // A malformed event is refused by `handleTap`; reading it here must not throw first.
      const orgId: unknown = (event as { orgId?: unknown } | null)?.orgId;
      const t = ticketFor(typeof orgId === 'string' ? orgId : '');
      if (!installed()) return;
      // A well-formed Open for an org this phone has now is the user choosing a machine, at the
      // tap, before any refresh: an automatic reopen still waiting gives way to it.
      const opening = isNotificationTappedEvent(event) && event.action !== 'mute_machine' && valid(t);
      if (opening) choseMachine();
      // An Open's claim, taken after its own choice: a machine chosen or a screen moved to since is
      // newer, and the tap then ends without a word, its alert kept. A Mute claims nothing of it.
      const choices = machineChoices();
      const from = window.location.hash;
      const owned = () => installed() && (!opening || (machineChoices() === choices && window.location.hash === from));
      void guarded('tap', async () => {
        if (typeof orgId === 'string' && !machinesStore.get()[orgId]?.machines.length) await refreshMachines(orgId);
        if (!owned()) return;
        await handleTap(tapDepsFor(t, installed, owned), event);
      });
    }),
    // A distributor change (no org) moves every org's endpoint.
    Push.addListener('endpointChanged', ({ orgId }) => {
      if (!installed()) return;
      const org = orgId === null ? undefined : findOrg(orgId);
      if (org) void reconcilePush(org, installed);
      else if (orgId === null) reconcileAllPush(installed);
    }),
    Push.addListener('pendingRegistrations', () => installed() && void drainAll(installed)),
  ]);
  const remove = () => {
    removed = true;
    handles.forEach((h) => void h.remove());
  };
  // Torn down while the listeners were still being added: remove them at once, start nothing.
  if (!installed()) return (remove(), remove);
  void drainAll(installed);
  return remove;
}

/** Why a Turn on or Turn off threw instead of answering, in words for the row; the code is the native or meta one. */
function toggleFailure(err: unknown): string {
  const code = rejectionCode(err);
  return code === 'offline' ? failureReason('offline') : `the request did not complete (${code})`;
}

/**
 * Turn on (`off` false, never at launch, only from the row's button) or Turn off. The org's turn
 * is taken at the press, before the permission prompt and every preparation, so two presses
 * apply in the order they were made and the last one decides. The toggle stays owed until the
 * Worker confirms it: a failure says so on the row and in a toast, and Retry repeats it.
 */
function toggle(org: OrgRecord, off: boolean): Promise<void> {
  const t = ticketFor(org.id);
  const deps = depsFor(t);
  return guarded(off ? 'turn off' : 'turn on', async () => {
    const r = await muteSync.run(
      deps,
      org.id,
      async (): Promise<ReconcileResult | null> => {
        // The permission step, preparation and the registration alike: a throw for the org as it
        // is now is a failure said on the row (the toggle stays owed for Retry); one for an org
        // gone since says nothing. A deliberate denial is not a failure and owes nothing.
        try {
          if (!off) {
            // The ticket's own push: an erase, a sign-out or a re-add before the prompt asks nothing.
          const granted = await turnOnPermission(deps.push, {
              showRationale: async () => (notify('info', pushText('push.rationale')), true),
              offerSettings: async () => true,
            });
            // The permission prompt can sit open for long: the org may be gone, or erased, by the answer.
            if (granted !== 'granted') return null;
          }
          muteSync.owe(deps, org.id, off);
          const pushOrg = await pushOrgOf(org, t);
          const meta = await deps.session.meta({ orgUrl: org.id });
          return await muteSync.registered(deps, org.id, deviceOf(org.id), (mutes, pushOff) => registerOrg(deps, pushOrg, meta, mutes, pushOff));
        } catch (err) {
          if (err instanceof StalePushOrg) throw err;
          muteSync.owe(deps, org.id, off);
          log('warn', `push ${off ? 'turn off' : 'turn on'} failed: ${rejectionCode(err)}`);
          return { kind: 'row', state: { kind: 'registration_failed', reason: toggleFailure(err) }, device: null };
        }
      },
      (r) => (r ? record(org, r, t) : undefined),
    );
    // A revocation already said so; anything but a confirmed toggle is not announced as one.
    if (!r || !valid(t) || r.kind !== 'row') return;
    const confirmed = r.device !== null && (r.device.push.kind === 'none') === off;
    if (off) notify(confirmed ? 'success' : 'error', pushText(confirmed ? 'push.toast.turned_off' : 'push.toast.turn_off_failed', { name: org.name }));
    else if (r.state.kind === 'registration_failed') notify('error', pushText('push.toast.turn_on_failed', { name: org.name }));
  });
}

export function pushAction(orgId: string, action: Exclude<RowAction, null>): Promise<void> {
  const org = findOrg(orgId);
  if (!org) return Promise.resolve();
  return guarded(action, async () => {
    switch (action) {
      case 'turn_on':
      case 'allow':
        return toggle(org, false);
      case 'open_settings':
        return Push.openNotificationSettings();
      case 'distributors':
        window.open(DISTRIBUTORS_URL, '_blank', 'noopener');
        return;
      case 'retry': {
        // A Turn on or Turn off that failed is retried as itself; anything else is checked again.
        const owed = muteSync.owedToggle(orgId);
        return owed === undefined ? reconcilePush(org) : toggle(org, owed);
      }
      case 'unmute':
        return patchMutes(orgId, { mute_all: false, muted_until: null });
    }
  });
}

export function turnOffPush(org: OrgRecord): Promise<void> {
  return toggle(org, true);
}

export function mutePushOrg(orgId: string, mode: 'hour' | 'forever'): Promise<void> {
  const patch: DevicePatch = mode === 'hour' ? { mute_all: false, muted_until: new Date(Date.now() + 3_600_000).toISOString() } : { mute_all: true };
  return guarded('mute', () => patchMutes(orgId, patch));
}

/** The Settings checkbox: adds or removes this one machine against the mutes in force at its turn. */
export function mutePushMachine(orgId: string, machineId: string, muted: boolean): Promise<void> {
  return guarded('mute machine', () => patchMutes(orgId, machineMute(machineId, muted)));
}

export function selectDistributor(distributor: string): Promise<void> {
  return guarded('distributor', async () => {
    await Push.selectDistributor({ distributor });
    reconcileAllPush();
  });
}
