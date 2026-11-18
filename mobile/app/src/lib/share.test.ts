/**
 * The share state as the latest write says (round 17): a status reply that a newer write outdated
 * never lands, so an older "none" cannot erase a newer share's pending state and an older
 * "pending" cannot bring back a share already sent or discarded. Only a file share counts as an
 * arrival.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/share.test.ts
 * ├── src/lib/native/machineView.ts
 * └── src/lib/share.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MachineView, type ShareStatus } from './native/machineView.ts';
import { onShareReceived, refreshShare, setShare, shareArrivals, shareStore } from './share.ts';

function heldStatus() {
  let answer!: (s: ShareStatus) => void;
  vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (answer = r)));
  return (s: ShareStatus) => answer(s);
}

beforeEach(() => {
  shareStore.set(null);
  vi.mocked(MachineView.shareStatus).mockReset().mockResolvedValue({ kind: 'none' });
});

describe('a status reply never overwrites a newer write', () => {
  it('an older "none" answering after a newer files event leaves the share pending', async () => {
    const older = heldStatus();
    const read = refreshShare();
    const newer = heldStatus();
    onShareReceived({ kind: 'files', count: 2, dropped: 0, batch: 'share-2' });
    older({ kind: 'none' });
    await read;
    expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: 'share-2' });
    newer({ kind: 'pending', count: 2, batch: 'share-2' });
    await vi.waitFor(() => expect(window.location.hash).toBe('#/share'));
  });

  it('an older "pending" answering after the share was discarded does not bring it back', async () => {
    const older = heldStatus();
    const read = refreshShare();
    setShare({ kind: 'none' });
    older({ kind: 'pending', count: 1, batch: 'share-1' });
    expect(await read).toEqual({ kind: 'none' });
    expect(shareStore.get()).toEqual({ kind: 'none' });
  });

  it('control: a reply nothing outdated is applied', async () => {
    vi.mocked(MachineView.shareStatus).mockResolvedValueOnce({ kind: 'pending', count: 3, batch: 'share-3' });
    expect(await refreshShare()).toEqual({ kind: 'pending', count: 3, batch: 'share-3' });
  });
});

describe('only a file share is an arrival', () => {
  it('files counts; a refused share does not', () => {
    const before = shareArrivals();
    onShareReceived({ kind: 'refused', reason: 'no_files' });
    expect(shareArrivals()).toBe(before);
    onShareReceived({ kind: 'files', count: 1, dropped: 0, batch: 'share-1' });
    expect(shareArrivals()).toBe(before + 1);
  });
});
