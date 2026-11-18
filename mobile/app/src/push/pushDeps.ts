/**
 * The live bindings of push orchestration: the native Push plugin, Phase 15's Session, and the
 * last reconcile answer per org.
 *
 * Kept apart from `pushWiring.ts` so the org store can unregister an org's push on sign-out
 * without an import cycle through the org list.
 *
 * - `unregisterOrgPush` is best effort: the sign-out that follows still removes the org.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushDeps.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/lib/api.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/store.ts
 * ├── src/push/muteSync.ts
 * └── src/push/pushRegistration.ts
 * External: none
 *
 * Used by:
 * src/push/pushDeps.ts
 * ├── src/intakeBoundaries.test.tsx
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushRaces.test.ts
 * ├── src/push/pushRejections.test.ts
 * ├── src/push/pushToggles.test.ts
 * ├── src/push/pushTurns.test.ts
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/screens/settings/NotificationSettings.tsx
 * └── src/screens/settings/notificationPreferences.test.tsx
 * <module-headers:end>
 */
import { Push } from '@yaran/push';

import { getMeta } from '../lib/api.ts';
import { log } from '../lib/diagnostics.ts';
import { Session } from '../lib/native/machineView.ts';
import { createStore } from '../lib/store.ts';
import { MuteSync } from './muteSync.ts';
import { currentDevice, removeOrgPush, StalePushOrg, type PushDeps, type ReconcileResult } from './pushRegistration.ts';

export { StalePushOrg };

export const pushDeps: PushDeps = {
  push: Push,
  session: {
    async meta({ orgUrl }) {
      const got = await getMeta(orgUrl);
      // The code rides along so a failed preparation can say which one it was.
      if (!got.ok) throw Object.assign(new Error(`meta: ${got.code}`), { code: got.code });
      return got.meta;
    },
    request: (options) => Session.request(options),
  },
};


/**
 * `pushDeps` for one incarnation of an org: every native push call and every org request asks
 * `live()` first and throws `StalePushOrg` when it is false. Work that awaited across a removal
 * (or an erase and a re-add) therefore stops before it forgets, registers or mutes anything of
 * the org now on this phone.
 */
export function scopedPushDeps(live: () => boolean): PushDeps {
  const guard = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(t, key) {
        const value: unknown = Reflect.get(t, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (!live()) throw new StalePushOrg();
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  return { push: guard(pushDeps.push), session: guard(pushDeps.session), live };
}

/** Offline mute patches waiting for the next reconcile; forgotten with the org (`removeOrgLocal`, erase). */
export const muteSync = new MuteSync();

/** The last reconcile answer per org; the Settings section renders it. */
export const pushStore = createStore<Record<string, ReconcileResult>>({});

/**
 * Org removal (sign out, erase): W14 for this phone's device row, then the local push keys.
 * `live` is the removal's own incarnation check; once false nothing more is touched.
 */
export async function unregisterOrgPush(orgId: string, live: () => boolean = () => true): Promise<void> {
  const deps = scopedPushDeps(live);
  try {
    const last = pushStore.get()[orgId];
    let deviceId = last?.kind === 'row' ? (last.device?.id ?? null) : null;
    if (deviceId === null) {
      const listed = await currentDevice(deps, orgId);
      deviceId = listed !== null && typeof listed === 'object' && 'id' in listed ? listed.id : null;
    }
    await removeOrgPush(deps, orgId, deviceId);
  } catch (err) {
    if (err instanceof StalePushOrg) return;
    log('warn', `could not unregister push for an org: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (live()) pushStore.update((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== orgId)));
}
