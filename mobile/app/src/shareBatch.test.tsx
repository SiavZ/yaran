/**
 * Share ownership by batch (round 19), through the real App and share screen, against a native
 * fake that compares the batch and acts in one step: Send and Discard carry the batch the screen
 * showed at the press; a newer share B that native took in before the command ran makes it
 * `share_changed`, and nothing of B is sent, discarded or hidden. Normal Send and Discard, a
 * `no_share`, and what crosses the bridge (only an opaque batch id) are pinned too.
 *
 * <module-headers:begin>
 * Uses:
 * src/shareBatch.test.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/lib/share.ts
 * └── src/test/render.tsx
 * External: @capacitor/app, @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { App as CapApp } from '@capacitor/app';
import { AppLock } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetBuildInfoForTests } from './lib/buildInfo.ts';
import { machinesStore, resetMachines } from './lib/machinesStore.ts';
import { MachineView, Session, type OpenOptions } from './lib/native/machineView.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { shareStore } from './lib/share.ts';
import { renderShell } from './test/render.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };
const MACHINE = { id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop.example.com', status: 'online' };
const A = '6f0b2c1e-1111-4a5b-8c9d-0e1f2a3b4c5d';
const B = '6f0b2c1e-2222-4a5b-8c9d-0e1f2a3b4c5d';
const tick = () => act(async () => new Promise((r) => setTimeout(r, 5)));
const said = (tone: 'info' | 'warning' | 'success' | 'error') => vi.mocked(toast[tone]).mock.calls.map((c) => renderShell(<>{c[0] as ReactNode}</>).container.textContent ?? '');
const listener = <E,>(name: string) =>
  (vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: E) => void][]).filter((c) => c[0] === name).at(-1)![1];

/**
 * Native's held share: one at a time, a newer one replacing it. A command compares the batch it
 * was given with the held one and acts in the same step. `meanwhile` runs once, inside the first
 * native call after the press (before a command's compare): a newer share native took in first.
 */
let held: { batch: string; count: number } | null;
let meanwhile: (() => void) | null;
const changed = () => Object.assign(new Error('another share is held'), { code: 'share_changed' });
const none = () => Object.assign(new Error('no share is held'), { code: 'no_share' });

/** Native takes in share B; `notify` also delivers its `shareReceived` to the shell. */
function nativeReceives(batch: string, count: number, notify: boolean) {
  held = { batch, count };
  if (notify) listener<unknown>('shareReceived')({ kind: 'files', count, dropped: 0, batch });
}

beforeEach(() => {
  resetBuildInfoForTests();
  resetMachines();
  shareStore.set(null);
  held = { batch: A, count: 1 };
  meanwhile = null;
  orgStore.set({ loaded: true, orgs: [ORG] });
  machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE] as never, fetchedAt: Date.now() } });
  settingsStore.set({ ...DEFAULT_SETTINGS });
  vi.mocked(AppLock.status).mockResolvedValue({ enabled: false, allowPasscode: false, grace: '1min', locked: false, biometry: 'available' });
  vi.mocked(Session.request).mockResolvedValue({ kind: 'ok', status: 200, body: { items: [MACHINE], next_cursor: null } });
  vi.mocked(MachineView.shareStatus).mockReset().mockImplementation(async () => {
    // B lands at whichever native call comes first after the press: a status read included, so
    // a caller that re-read the batch after the press would name B.
    meanwhile?.();
    return held ? { kind: 'pending', count: held.count, batch: held.batch } : { kind: 'none' };
  });
  vi.mocked(MachineView.open).mockReset().mockImplementation(async (o: OpenOptions) => {
    if (o.shareBatch === undefined) return;
    meanwhile?.();
    if (!held) throw none();
    if (held.batch !== o.shareBatch) throw changed();
    held = null;
  });
  vi.mocked(MachineView.discardShare).mockReset().mockImplementation(async ({ batch }) => {
    meanwhile?.();
    if (!held) return;
    if (held.batch !== batch) throw changed();
    held = null;
  });
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
});

/** The share screen showing A, with the App's listeners in place. */
async function showingA() {
  window.location.hash = '#/share';
  const shell = renderShell(<App />);
  expect(await screen.findByRole('heading', { name: 'Send 1 file to…' })).toBeTruthy();
  await waitFor(() => expect((vi.mocked(MachineView.addListener).mock.calls as unknown[][]).some((c) => c[0] === 'shareReceived')).toBe(true));
  await tick();
  return shell;
}
const press = (command: 'send' | 'discard') => fireEvent.click(screen.getByRole('button', { name: command === 'send' ? 'laptop' : 'Cancel and discard' }));

describe('a newer share native took in before the command ran is never sent, discarded or hidden', () => {
  for (const command of ['send', 'discard'] as const) {
    for (const notify of [false, true]) {
      it(`${command}, B ${notify ? 'also announced to the shell' : 'not yet announced'} first: share_changed, B stays, the screen shows B`, async () => {
        await showingA();
        meanwhile = () => ((meanwhile = null), nativeReceives(B, 2, notify));
        press(command);
        expect(await screen.findByRole('heading', { name: 'Send 2 files to…' })).toBeTruthy();
        await tick();
        // The command named the share on screen, A, and native refused it: B is untouched.
        if (command === 'send') expect(vi.mocked(MachineView.open).mock.calls.at(-1)![0]).toMatchObject({ shareBatch: A });
        else expect(MachineView.discardShare).toHaveBeenLastCalledWith({ batch: A });
        expect(held).toEqual({ batch: B, count: 2 });
        expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: B });
        expect(window.location.hash).toBe('#/share');
        expect(said('info').join(' ')).toMatch(command === 'send' ? /nothing was sent/ : /nothing was discarded/);
        expect(said('success')).toEqual([]);
        expect(said('info').join(' ')).not.toMatch(/Discarded the shared files/);
      });
    }
  }
});

describe('the ordinary paths', () => {
  it('Send hands over exactly A and leaves the screen', async () => {
    await showingA();
    press('send');
    await waitFor(() => expect(window.location.hash).toBe('#/machines'));
    expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname, shareBatch: A });
    expect(held).toBeNull();
    expect(shareStore.get()).toEqual({ kind: 'none' });
  });

  it('Discard forgets exactly A and says so', async () => {
    await showingA();
    press('discard');
    await waitFor(() => expect(window.location.hash).toBe('#/machines'));
    expect(MachineView.discardShare).toHaveBeenCalledWith({ batch: A });
    expect(held).toBeNull();
    expect(said('info').join(' ')).toMatch(/Discarded the shared files/);
  });

  it('A gone before Send (no share held): no_share, said truthfully, nothing opens', async () => {
    await showingA();
    meanwhile = () => ((meanwhile = null), (held = null));
    press('send');
    await waitFor(() => expect(said('warning').join(' ')).toMatch(/no longer waiting/));
    expect(await screen.findByText('No shared files are waiting.')).toBeTruthy();
    expect(window.location.hash).toBe('#/share');
  });

  it('A gone before Discard: nothing is held, which is what Discard wanted', async () => {
    await showingA();
    meanwhile = () => ((meanwhile = null), (held = null));
    press('discard');
    await waitFor(() => expect(window.location.hash).toBe('#/machines'));
    expect(MachineView.discardShare).toHaveBeenCalledWith({ batch: A });
  });

  it('only an opaque batch id crosses the bridge, and the share state holds nothing else', async () => {
    await showingA();
    meanwhile = () => ((meanwhile = null), nativeReceives(B, 2, true));
    press('send');
    expect(await screen.findByRole('heading', { name: 'Send 2 files to…' })).toBeTruthy();
    const sent = [...vi.mocked(MachineView.open).mock.calls.map((c) => c[0]), ...vi.mocked(MachineView.discardShare).mock.calls.map((c) => c[0])];
    for (const options of sent) for (const value of Object.values(options)) expect(String(value)).not.toMatch(/content:|file:|\/storage\//);
    expect(Object.keys(shareStore.get()!).sort()).toEqual(['batch', 'count', 'kind']);
  });
});

/** Native acts on A at once (it is gone), but its reply to the shell waits for `complete`. */
function replyHeld(command: 'send' | 'discard') {
  let complete!: () => void;
  const reply = new Promise<void>((r) => (complete = r));
  const act_ = () => ((held = null), reply);
  if (command === 'send') vi.mocked(MachineView.open).mockImplementationOnce(act_);
  else vi.mocked(MachineView.discardShare).mockImplementationOnce(act_);
  return () => complete();
}
const appUrl = (url: string) =>
  act(() => (vi.mocked(CapApp.addListener).mock.calls as unknown as [string, (e: { url: string }) => void][]).filter((c) => c[0] === 'appUrlOpen').at(-1)![1]({ url }));
const unlocked = () =>
  act(() => (vi.mocked(AppLock.addListener).mock.calls as unknown as [string, (e: { locked: boolean }) => void][]).filter((c) => c[0] === 'lockStateChanged').at(-1)![1]({ locked: false }));

describe("a late reply settles A by A's identity, and only this screen acts on it", () => {
  for (const command of ['send', 'discard'] as const) {
    it(`${command}: B found by a status read before its event, then A's success: B stays held, known and on screen`, async () => {
      await showingA();
      const complete = replyHeld(command);
      press(command);
      await tick();
      // Native takes in B without an event; the unlock's status read finds it first.
      act(() => nativeReceives(B, 2, false));
      unlocked();
      expect(await screen.findByRole('heading', { name: 'Send 2 files to…' })).toBeTruthy();
      await act(async () => complete());
      await tick();
      expect(held).toEqual({ batch: B, count: 2 });
      expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: B });
      expect(window.location.hash).toBe('#/share');
    });

    it(`${command}: a Settings link while the reply waits keeps Settings, and A is still known as gone`, async () => {
      await showingA();
      const complete = replyHeld(command);
      press(command);
      await tick();
      appUrl('yaranapp://settings');
      await waitFor(() => expect(window.location.hash).toBe('#/settings'));
      await act(async () => complete());
      await tick();
      expect(window.location.hash).toBe('#/settings');
      expect(shareStore.get()).toEqual({ kind: 'none' });
      expect(said('info').join(' ')).not.toMatch(/Discarded the shared files/);
    });

    it(`${command}: the App torn down while the reply waits: nothing navigates or speaks afterwards`, async () => {
      const shell = await showingA();
      const complete = replyHeld(command);
      press(command);
      await tick();
      shell.unmount();
      act(() => navigate({ name: 'settings' }));
      for (const t of Object.values(toast)) vi.mocked(t).mockClear();
      await act(async () => complete());
      await tick();
      expect(window.location.hash).toBe('#/settings');
      expect([...said('info'), ...said('success'), ...said('warning'), ...said('error')]).toEqual([]);
    });
  }

  it('share_changed after the screen was left: nothing is said to a screen that is gone', async () => {
    const shell = await showingA();
    let complete!: () => void;
    vi.mocked(MachineView.open).mockImplementationOnce(() => new Promise<void>((_, reject) => (complete = () => reject(changed()))));
    press('send');
    await tick();
    shell.unmount();
    for (const t of Object.values(toast)) vi.mocked(t).mockClear();
    await act(async () => complete());
    await tick();
    expect(said('info')).toEqual([]);
  });
});

describe('no_share decides what to say after its last await', () => {
  it("B arrives and shows while the refresh after A's no_share waits: no obsolete warning, and B stays", async () => {
    await showingA();
    let finish!: () => void;
    vi.mocked(MachineView.open).mockRejectedValueOnce(none());
    vi.mocked(MachineView.shareStatus).mockImplementationOnce(() => new Promise((r) => (finish = () => r({ kind: 'pending', count: 2, batch: B }))));
    press('send');
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    act(() => nativeReceives(B, 2, true));
    expect(await screen.findByRole('heading', { name: 'Send 2 files to…' })).toBeTruthy();
    await act(async () => finish());
    await tick();
    expect(shareStore.get()).toEqual({ kind: 'pending', count: 2, batch: B });
    expect(said('warning').join(' ')).not.toMatch(/no longer waiting/);
  });

  it('the refresh after no_share fails: A is still known as gone, and the warning is said', async () => {
    await showingA();
    held = null;
    vi.mocked(MachineView.open).mockRejectedValueOnce(none());
    vi.mocked(MachineView.shareStatus).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'native_error' }));
    press('send');
    await waitFor(() => expect(said('warning').join(' ')).toMatch(/no longer waiting/));
    expect(shareStore.get()).toEqual({ kind: 'none' });
  });
});

describe('a link that moved the address before React let the screen go still wins', () => {
  // The link's listener, called outside act: the hash changes now and React's cleanup comes later.
  const followLink = (url: string) =>
    (vi.mocked(CapApp.addListener).mock.calls as unknown as [string, (e: { url: string }) => void][]).filter((c) => c[0] === 'appUrlOpen').at(-1)![1]({ url });
  async function untilSettings() {
    for (let i = 0; i < 30 && window.location.hash !== '#/settings'; i++) await Promise.resolve();
    expect(window.location.hash).toBe('#/settings');
  }

  for (const command of ['send', 'discard'] as const) {
    it(`${command}: the reply lands between the address change and the unmount; Settings stays and nothing is said`, async () => {
      await showingA();
      const complete = replyHeld(command);
      press(command);
      await tick();
      for (const t of Object.values(toast)) vi.mocked(t).mockClear();
      followLink('yaranapp://settings');
      await untilSettings();
      complete();
      await new Promise((r) => setTimeout(r, 20));
      await tick();
      expect(window.location.hash).toBe('#/settings');
      expect([...said('info'), ...said('warning'), ...said('error'), ...said('success')]).toEqual([]);
      // The global settle still forgets the consumed A.
      expect(shareStore.get()).toEqual({ kind: 'none' });
    });
  }

  it('a failed open whose reply lands in that gap says nothing on the screen that was left', async () => {
    await showingA();
    let fail!: () => void;
    vi.mocked(MachineView.open).mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = () => reject(Object.assign(new Error('x'), { code: 'native_error' })))));
    press('send');
    await tick();
    for (const t of Object.values(toast)) vi.mocked(t).mockClear();
    followLink('yaranapp://settings');
    await untilSettings();
    fail();
    await new Promise((r) => setTimeout(r, 20));
    await tick();
    expect(said('error')).toEqual([]);
    expect(window.location.hash).toBe('#/settings');
  });
});

describe('Send on a cold-start chooser is a machine choice the startup reopen gives way to', () => {
  const OTHER = { ...MACHINE, id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c', name: 'desktop', hostname: 'desktop.example.com' };
  /** Starts at #/share with the launch URL read held and the share found by status only. */
  async function coldChooser() {
    let release!: (v: undefined) => void;
    vi.mocked(CapApp.getLaunchUrl).mockImplementationOnce(() => new Promise((r) => (release = r)));
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE, OTHER] as never, fetchedAt: Date.now() } });
    vi.mocked(Session.request).mockResolvedValue({ kind: 'ok', status: 200, body: { items: [MACHINE, OTHER], next_cursor: null } });
    settingsStore.set({ ...DEFAULT_SETTINGS, reopenLastMachine: true, lastMachine: { orgId: ORG.id, machineId: OTHER.id, host: OTHER.hostname } });
    window.location.hash = '#/share';
    renderShell(<App />);
    await screen.findByRole('heading', { name: 'Send 1 file to…' });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    return () => release(undefined);
  }
  const opens = () => vi.mocked(MachineView.open).mock.calls.map((c) => c[0]);
  const SENT_A = { orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname, shareBatch: A };

  it('Send consumed A natively, its reply held, then the launch read finishes: only A ever opens', async () => {
    const release = await coldChooser();
    const complete = replyHeld('send');
    press('send');
    await tick();
    await act(async () => release());
    await tick();
    await tick();
    expect(opens()).toEqual([SENT_A]);
    await act(async () => complete());
    await tick();
    expect(opens()).toEqual([SENT_A]);
  });

  it('control: no press, the chooser keeps the launch and nothing reopens', async () => {
    const release = await coldChooser();
    await act(async () => release());
    await tick();
    expect(MachineView.open).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/share');
  });

  it('control: Send answered at once, then the launch read finishes: only A opens', async () => {
    const release = await coldChooser();
    press('send');
    await waitFor(() => expect(window.location.hash).toBe('#/machines'));
    await act(async () => release());
    await tick();
    expect(opens()).toEqual([SENT_A]);
  });
});
