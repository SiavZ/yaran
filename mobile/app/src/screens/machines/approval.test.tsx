/**
 * Approvals abandoned while the native sign-in or the save is out, and same-host ordering: an
 * abandoned approval saves nothing and ends the session it minted inside its own same-host
 * turn; a second approval on the host signs in only after that; Erase everything waits for the
 * turn and refuses new ones; a save being written when the screen goes away is undone.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/approval.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import type { MachineSummary } from '@yaran/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogRefusal, directStore, withHost } from '../../lib/directStore.ts';
import { Session, type DirectStatus } from '../../lib/native/machineView.ts';
import { machinesStore, resetMachines } from '../../lib/machinesStore.ts';
import { eraseEverything, orgStore } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { vault } from '../../test/setup.ts';
import { renderShell } from '../../test/render.tsx';
import { ConfirmMachine } from '../onboarding/ConfirmMachine.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const HOST = 'box.tail1.ts.net';
const yaran = (over: Partial<Extract<DirectStatus, { kind: 'yaran' }>> = {}): DirectStatus => ({
  kind: 'yaran',
  instance: 'inst-1',
  passwordSet: true,
  requiredHere: false,
  signedIn: false,
  transportEncrypted: true,
  ...over,
});
const route = () => parseRoute(window.location.hash);

beforeEach(() => {
  vi.mocked(Session.directStatus).mockReset();
  vi.mocked(Session.directSignIn).mockReset();
});

describe('an approval abandoned while the native sign-in is open', () => {
  type SignedIn = { kind: 'signed_in'; host: string; instance: string | null; signInId: string };
  function pendingSignIn() {
    let finish!: (o: SignedIn) => void;
    vi.mocked(Session.directSignIn).mockImplementationOnce(() => new Promise((r) => (finish = r)));
    return () => finish({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: 'sid-1' });
  }
  async function start() {
    const view = renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    await waitFor(() => expect(Session.directSignIn).toHaveBeenCalled());
    return view;
  }
  beforeEach(() => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    window.location.hash = '#/confirm-machine?h=' + HOST;
  });

  it('after leaving the screen: saves nothing, goes nowhere, and ends the session it minted', async () => {
    const finish = pendingSignIn();
    const view = await start();
    view.unmount();
    finish();
    await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' }));
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
    expect(route()).toEqual({ name: 'confirm-machine', host: HOST });
    expect(toast.success).not.toHaveBeenCalled();
  });

  /** Native sign-ins, sign-outs and vault wipes in the order they happened, as `in` / `out` / `erase`. */
  const order = () =>
    (
      [
        ['in', vi.mocked(Session.directSignIn).mock.invocationCallOrder],
        ['out', vi.mocked(Session.directSignOut).mock.invocationCallOrder],
        ['erase', vi.mocked(SecureStore.eraseAll).mock.invocationCallOrder],
      ] as const
    )
      .flatMap(([name, at]) => at.map((n) => [n, name] as const))
      .sort((x, y) => x[0] - y[0])
      .map(([, name]) => name);

  it('leaving while the save is being written: the write is undone, nothing shows, nothing navigates', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran());
    const real = vi.mocked(SecureStore.set).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
    const view = renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add machine' }));
    await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    view.unmount();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(directStore.get().machines).toEqual([]);
    expect(JSON.parse(vault.get('direct/list') ?? '[]')).toEqual([]);
    expect(route()).toEqual({ name: 'confirm-machine', host: HOST });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('Erase everything waits for the open sign-in, which ends its own session in its turn; nothing is recreated', async () => {
    const finish = pendingSignIn();
    await start();
    const erasing = eraseEverything();
    await new Promise((r) => setTimeout(r, 10));
    expect(SecureStore.eraseAll).not.toHaveBeenCalled();
    await expect(withHost('other.example.com', async () => 'ran')).rejects.toEqual(new CatalogRefusal('erased'));
    vi.mocked(SecureStore.eraseAll).mockImplementationOnce(async () => {
      expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' });
      vault.clear();
    });
    finish();
    await erasing;
    expect(SecureStore.eraseAll).toHaveBeenCalledTimes(1);
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
    expect(route()).toEqual({ name: 'confirm-machine', host: HOST });
    // Reopened afterwards.
    expect(await withHost('other.example.com', async () => 'ran')).toBe('ran');
  });

  it('a second approval on the host signs in only after the first one cleaned up', async () => {
    const finishOld = pendingSignIn();
    const old = await start();
    old.unmount();
    const finishNew = pendingSignIn();
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(order()).toEqual(['in']);
    finishOld();
    await waitFor(() => expect(order()).toEqual(['in', 'out', 'in']));
    finishNew();
    await waitFor(() => expect(directStore.get().machines.map((m) => m.host)).toEqual([HOST]));
    expect(order()).toEqual(['in', 'out', 'in']);
  });

  it('A abandoned, B abandoned before its turn, A returns: A cleans up and B never signs in', async () => {
    const finishOld = pendingSignIn();
    const old = await start();
    old.unmount();
    const second = renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    second.unmount();
    finishOld();
    await waitFor(() => expect(order()).toEqual(['in', 'out']));
    await new Promise((r) => setTimeout(r, 10));
    expect(order()).toEqual(['in', 'out']);
    expect(directStore.get().machines).toEqual([]);
  });

  it('A pending, B queued, erase: A cleans up, B never signs in, erase finishes last', async () => {
    const finishOld = pendingSignIn();
    await start();
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Sign in and continue' })).at(-1)!);
    const erasing = eraseEverything();
    finishOld();
    await erasing;
    expect(order()).toEqual(['in', 'out', 'erase']);
    expect(directStore.get().machines).toEqual([]);
  });

  /** The text of the last error toast, rendered: the toast may be raised after the screen is gone. */
  const lastError = () => renderShell(<>{vi.mocked(toast.error).mock.calls.at(-1)?.[0] as ReactNode}</>).container.textContent ?? '';

  it('a clean-up native cannot do keeps the machine listed and says so, after the screen is gone', async () => {
    const finish = pendingSignIn();
    const view = await start();
    view.unmount();
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'secure_storage_failed' });
    finish();
    await waitFor(() => expect(directStore.get().machines.map((m) => [m.host, m.instance])).toEqual([[HOST, 'inst-1']]));
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' });
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(lastError()).toContain('secure_storage_failed');
    expect(lastError()).toContain('listed under Machines');
  });

  it('a clean-up answered not_current leaves the newer sign-in alone and lists nothing', async () => {
    const finish = pendingSignIn();
    const view = await start();
    view.unmount();
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'not_current' });
    finish();
    await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(directStore.get().machines).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('during an erase a failed clean-up lists nothing: the erase owns the list and ends empty', async () => {
    const finish = pendingSignIn();
    await start();
    const erasing = eraseEverything();
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'secure_storage_failed' });
    finish();
    await erasing;
    expect(directStore.get().machines).toEqual([]);
    expect(vault.get('direct/list')).toBeUndefined();
  });

  /** Holds the next vault write until `release`; `undo` decides how the write after it ends. */
  function holdSave(undo: 'works' | 'fails') {
    const real = vi.mocked(SecureStore.set).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
    if (undo === 'fails') vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('disk'), { code: 'native_error' }));
    return () => release();
  }

  it('leaving while the save is written: the save is undone, and a failed clean-up lists it again with a toast', async () => {
    const finish = pendingSignIn();
    const release = holdSave('works');
    const view = await start();
    finish();
    await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    view.unmount();
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'vault_locked' });
    release();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(directStore.get().machines.map((m) => m.host)).toEqual([HOST]);
    expect(JSON.parse(vault.get('direct/list')!).map((m: { host: string }) => m.host)).toEqual([HOST]);
    expect(lastError()).toContain('vault_locked');
  });

  it('when both the save and its undo hit the vault after leaving, the toast says it stays listed, with its code', async () => {
    const finish = pendingSignIn();
    const release = holdSave('fails');
    const view = await start();
    finish();
    await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
    view.unmount();
    release();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(lastError()).toContain('rollback_failed');
    expect(lastError()).toContain('stays listed under Machines');
    expect(directStore.get().machines.map((m) => m.host)).toEqual([HOST]);
    // The listed machine owns the session: nothing signs it out.
    expect(Session.directSignOut).not.toHaveBeenCalled();
  });

  /**
   * A fake native session store for one host, following the contract's conditional sign-out: a
   * sign-in replaces the host's current one; `directSignOut` with a `signInId` that is not the
   * current one touches nothing and answers `not_current`; without an id it ends whatever is current.
   */
  function fakeNativeHost() {
    const native = { current: null as string | null };
    let n = 0;
    vi.mocked(Session.directSignOut).mockImplementation(async ({ signInId }) => {
      if (signInId !== undefined && signInId !== native.current) return { kind: 'not_current' };
      native.current = null;
      return { kind: 'signed_out', serverEnded: true };
    });
    const shellSignIn = () => {
      let finish!: () => void;
      vi.mocked(Session.directSignIn).mockImplementationOnce(
        () =>
          new Promise((r) => {
            finish = () => {
              native.current = `shell-${++n}`;
              r({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: native.current });
            };
          }),
      );
      return () => finish();
    };
    // The machine window's own password sheet: a native sign-in the shell never sees.
    const windowSignsIn = () => (native.current = 'window-1');
    return { native, shellSignIn, windowSignsIn };
  }

  it("A in the shell abandoned, B in the machine window signed in since: A's clean-up leaves B's session alone", async () => {
    const { native, shellSignIn, windowSignsIn } = fakeNativeHost();
    const finish = shellSignIn();
    const view = await start();
    view.unmount();
    // A's sign-in lands, then the window's sign-in replaces it before A's clean-up runs.
    vi.mocked(Session.directSignOut).mockImplementationOnce(async ({ signInId }) => {
      windowSignsIn();
      return signInId === native.current ? { kind: 'signed_out', serverEnded: true } : { kind: 'not_current' };
    });
    finish();
    await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'shell-1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(native.current).toBe('window-1');
    expect(directStore.get().machines).toEqual([]);
    expect(toast.error).not.toHaveBeenCalled();
    vi.mocked(Session.directSignOut).mockImplementation(async () => ({ kind: 'signed_out', serverEnded: true }));
  });

  it('with no other sign-in on the host, A ends exactly its own session', async () => {
    const { native, shellSignIn } = fakeNativeHost();
    const finish = shellSignIn();
    const view = await start();
    view.unmount();
    finish();
    await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'shell-1' }));
    await waitFor(() => expect(native.current).toBeNull());
    expect(directStore.get().machines).toEqual([]);
    vi.mocked(Session.directSignOut).mockImplementation(async () => ({ kind: 'signed_out', serverEnded: true }));
  });

  describe('an org claims the host while the approval waits', () => {
    const ORG = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' };
    const claim = () => {
      orgStore.set({ loaded: true, orgs: [ORG] });
      machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: 'm1', name: 'box', hostname: HOST } as MachineSummary], fetchedAt: 0 } });
    };
    afterEach(() => {
      orgStore.set({ loaded: true, orgs: [] });
      resetMachines();
    });

    it('during the sign-in: it ends exactly the sign-in it minted, lists nothing, and says who owns the host', async () => {
      const finish = pendingSignIn();
      await start();
      claim();
      finish();
      await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledTimes(1));
      expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' });
      expect(directStore.get().machines).toEqual([]);
      expect(vault.get('direct/list')).toBeUndefined();
      expect(await screen.findByText(/belongs to/)).toBeTruthy();
    });

    it("the window's newer sign-in on the host answers not_current and stays", async () => {
      const { native, shellSignIn, windowSignsIn } = fakeNativeHost();
      const finish = shellSignIn();
      await start();
      claim();
      vi.mocked(Session.directSignOut).mockImplementationOnce(async ({ signInId }) => {
        windowSignsIn();
        return signInId === native.current ? { kind: 'signed_out', serverEnded: true } : { kind: 'not_current' };
      });
      finish();
      await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'shell-1' }));
      await new Promise((r) => setTimeout(r, 10));
      expect(native.current).toBe('window-1');
      expect(directStore.get().machines).toEqual([]);
      expect(toast.error).not.toHaveBeenCalled();
      vi.mocked(Session.directSignOut).mockImplementation(async () => ({ kind: 'signed_out', serverEnded: true }));
    });

    it('while the save is written: the save is undone and its own sign-in ended', async () => {
      const finish = pendingSignIn();
      const real = vi.mocked(SecureStore.set).getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
      await start();
      finish();
      await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
      claim();
      release();
      await waitFor(() => expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' }));
      expect(directStore.get().machines).toEqual([]);
      expect(JSON.parse(vault.get('direct/list') ?? '[]')).toEqual([]);
    });
  });
});
