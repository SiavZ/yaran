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
 * └── src/push/pushRegistration.ts
 * External: none
 *
 * Used by:
 * src/push/pushDeps.ts
 * ├── src/lib/orgStore.ts
 * ├── src/push/pushWiring.test.ts
 * ├── src/push/pushWiring.ts
 * └── src/screens/settings/NotificationSettings.tsx
 * <module-headers:end>
 */
import { Push } from '@yaran/push';

import { getMeta } from '../lib/api.ts';
import { log } from '../lib/diagnostics.ts';
import { Session } from '../lib/native/machineView.ts';
import { createStore } from '../lib/store.ts';
import { currentDevice, removeOrgPush, type PushDeps, type ReconcileResult } from './pushRegistration.ts';

export const pushDeps: PushDeps = {
  push: Push,
  session: {
    async meta({ orgUrl }) {
      const got = await getMeta(orgUrl);
      if (!got.ok) throw new Error(`meta: ${got.code}`);
      return got.meta;
    },
    request: (options) => Session.request(options),
  },
};

/** The last reconcile answer per org; the Settings section renders it. */
export const pushStore = createStore<Record<string, ReconcileResult>>({});

/** Org removal (sign out, erase): W14 for this phone's device row, then the local push keys. */
export async function unregisterOrgPush(orgId: string): Promise<void> {
  try {
    const last = pushStore.get()[orgId];
    let deviceId = last?.kind === 'row' ? (last.device?.id ?? null) : null;
    if (deviceId === null) {
      const listed = await currentDevice(pushDeps, orgId);
      deviceId = listed !== null && typeof listed === 'object' && 'id' in listed ? listed.id : null;
    }
    await removeOrgPush(pushDeps, orgId, deviceId);
  } catch (err) {
    log('warn', `could not unregister push for an org: ${err instanceof Error ? err.message : String(err)}`);
  }
  pushStore.update((s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== orgId)));
}
