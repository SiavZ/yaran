/**
 * Share intake (G5): what another app's share left waiting, as a count and a state only.
 *
 * Native holds the files (at most `MAX_SHARED_FILES`) and hands this module nothing but
 * `{kind: "none"}` or `{kind: "pending", count}`; no URI, name, path or byte crosses the
 * bridge. `MachineView.shareStatus` is the truth: the `shareReceived` event only says "look
 * again", so a cold start (status pulled) and a retained event (pushed) land on the same
 * screen once rather than delivering twice.
 *
 * - A refused share (`no_files`, `unsupported_os`) is said once, as a toast.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/share.ts
 * ├── src/lib/assertNever.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/route.ts
 * └── src/lib/store.ts
 * External: @lingui/core
 *
 * Used by:
 * src/lib/share.ts
 * ├── src/App.tsx
 * ├── src/continuations.test.tsx
 * ├── src/explicitOpen.test.tsx
 * ├── src/lib/lifecycle.test.ts
 * ├── src/lib/lifecycle.ts
 * ├── src/lib/share.test.ts
 * ├── src/reopenPriority.test.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/machines/direct.test.tsx
 * └── src/shareBatch.test.tsx
 * <module-headers:end>
 */
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';

import { assertNever } from './assertNever.ts';
import { log } from './diagnostics.ts';
import { MachineView, type ShareReceivedEvent, type ShareStatus } from './native/machineView.ts';
import { notify } from './notify.ts';
import { navigate } from './route.ts';
import { createStore } from './store.ts';

/** `null` until native has answered once this run. */
export const shareStore = createStore<ShareStatus | null>(null);

// Every write to the share state takes a number, and a read applies its answer only when nothing
// was written since it began: an older reply never erases a newer share's pending state, nor
// brings back one already sent or discarded.
let version = 0;
// File shares that arrived this run, counted at the event: a newer intent than a startup reopen.
let arrived = 0;

/** Sets the share state as a write (a send, a discard, an event): any read already out yields to it. */
export function setShare(status: ShareStatus): void {
  version += 1;
  shareStore.set(status);
}

export const shareArrivals = (): number => arrived;

/** Re-reads the held share; a rejection (an older native), or an answer a newer write outdated, leaves the last state. */
export async function refreshShare(): Promise<ShareStatus | null> {
  const at = ++version;
  try {
    const status = await MachineView.shareStatus();
    if (at === version) shareStore.set(status);
  } catch (err) {
    log('warn', `could not read the held share: ${err instanceof Error ? err.message : String(err)}`);
  }
  return shareStore.get();
}

/** Shows the share screen when files are waiting; resolves whether it did. `alive` is asked after the pull. */
export async function routeToPendingShare(alive: () => boolean = () => true): Promise<boolean> {
  const status = await refreshShare();
  if (!alive() || status?.kind !== 'pending') return false;
  navigate({ name: 'share' });
  return true;
}

export function onShareReceived(event: ShareReceivedEvent, alive: () => boolean = () => true): void {
  switch (event.kind) {
    case 'files':
      // The event's count stands in until the pull answers (or when an older native cannot).
      arrived += 1;
      setShare({ kind: 'pending', count: event.count, batch: event.batch });
      if (event.dropped > 0) {
        const left = plural(event.dropped, { one: '# shared item was left out', other: '# shared items were left out' });
        notify('warning', i18n._(msg`${left}: the app takes up to 10 files, and only ones the other app hands over directly.`));
      }
      void routeToPendingShare(alive);
      return;
    case 'refused':
      switch (event.reason) {
        case 'no_files':
          notify('warning', i18n._(msg`Share a file to yaran; text isn't supported yet.`));
          return;
        case 'unsupported_os':
          notify('warning', i18n._(msg`This version of iOS can't hand shared files to a machine page. Update to iOS 18.4 or later.`));
          return;
        default:
          return assertNever(event.reason);
      }
    default:
      return assertNever(event);
  }
}
