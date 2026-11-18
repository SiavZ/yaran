/**
 * DOM tests for the direct-machine flows: Confirm machine (guard, probe sentences, native
 * sign-in, retry truthfulness, instance mismatch, metadata-only save), the Direct section
 * (Open, Sign in again, Remove), Ways to reach it (instance-checked typed routes, org routes,
 * reorder, remove) and the share screen (pick, no_share, cancel).
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/direct.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/share.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/machines/ShareTarget.tsx
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MachineSummary } from '@yaran/protocol';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addDirect, directStore, updateDirect } from '../../lib/directStore.ts';
import { machinesStore, resetMachines } from '../../lib/machinesStore.ts';
import { MachineView, Session, type DirectStatus } from '../../lib/native/machineView.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { shareStore } from '../../lib/share.ts';
import { vault } from '../../test/setup.ts';
import { renderShell } from '../../test/render.tsx';
import { ConfirmMachine } from '../onboarding/ConfirmMachine.tsx';
import { MachineList } from './MachineList.tsx';
import { addCheckedOrgRoute, MachineRoutes } from './MachineRoutes.tsx';
import { ShareTarget } from './ShareTarget.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const HOST = 'box.tail1.ts.net';
const ORG = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' };
const MACHINE = { id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop-ada.example.com', status: 'online' } as MachineSummary;
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
  resetMachines();
  orgStore.set({ loaded: true, orgs: [] });
  shareStore.set(null);
  vi.mocked(Session.request).mockResolvedValue({ kind: 'ok', status: 200, body: { items: [], next_cursor: null } });
  vi.mocked(Session.directStatus).mockReset();
  vi.mocked(Session.directSignIn).mockReset();
});

describe('ConfirmMachine', () => {
  it('adds a machine that needs no password after an explicit press, storing metadata only', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran());
    renderShell(<ConfirmMachine host={HOST} />);
    expect(await screen.findByText(/lets this network in without a password/)).toBeTruthy();
    expect(screen.getByText('inst-1')).toBeTruthy();
    expect(directStore.get().machines).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }));
    await waitFor(() => expect(route()).toEqual({ name: 'machines' }));
    expect(Session.directSignIn).not.toHaveBeenCalled();
    expect(directStore.get().machines.map((m) => [m.host, m.instance])).toEqual([[HOST, 'inst-1']]);
    expect(vault.get('direct/list')).not.toMatch(/token|password|cookie/i);
  });

  it('signs in through the native sheet before saving, and retries a wrong password truthfully', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    vi.mocked(Session.directSignIn)
      .mockResolvedValueOnce({ kind: 'wrong_password', message: 'That password is wrong.' })
      .mockResolvedValueOnce({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: 'sid-1' });
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    expect(await screen.findByText('That password is wrong.')).toBeTruthy();
    expect(directStore.get().machines).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(route()).toEqual({ name: 'machines' }));
    expect(Session.directSignIn).toHaveBeenCalledWith({ host: HOST });
    expect(directStore.get().machines).toHaveLength(1);
  });

  it('holds Try again for the machine rate limit', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
      vi.mocked(Session.directSignIn).mockResolvedValueOnce({ kind: 'rate_limited', retryAfterSeconds: 30, message: 'Too many attempts; wait 30 seconds.' });
      renderShell(<ConfirmMachine host={HOST} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
      const retry = await screen.findByRole('button', { name: 'Try again' });
      expect(retry.hasAttribute('disabled')).toBe(true);
      // Let the wait's effect schedule its timer before the clock moves.
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(29_000);
      });
      expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Try again' }).hasAttribute('disabled')).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it('signs out again and adds nothing when the sign-in answers as another instance', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    vi.mocked(Session.directSignIn).mockResolvedValueOnce({ kind: 'signed_in', host: HOST, instance: 'impostor', signInId: 'sid-1' });
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    expect(await screen.findByText(/A different yaran answered the sign-in/)).toBeTruthy();
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' });
    expect(directStore.get().machines).toEqual([]);
  });

  it('names a secure storage failure during sign-in, never a lock, and adds nothing', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    vi.mocked(Session.directSignIn).mockResolvedValueOnce({ kind: 'secure_storage_failed' });
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    const said = (await screen.findByText(/secure storage/)).textContent!;
    expect(said).not.toMatch(/Unlock/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(directStore.get().machines).toEqual([]);
  });

  it('ends a fresh sign-in when the save fails, and shows the real code', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    vi.mocked(Session.directSignIn).mockResolvedValueOnce({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: 'sid-1' });
    const { SecureStore } = await import('@yaran/secure-store');
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('keystore'), { code: 'key_invalidated' }));
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    expect((await screen.findByText(/couldn't save this on the phone/)).textContent).toContain('key_invalidated');
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST, signInId: 'sid-1' });
  });

  it('offers no add when the machine needs a password it does not have', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true, passwordSet: false }));
    renderShell(<ConfirmMachine host={HOST} />);
    expect(await screen.findByText(/needs a password and has none/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add machine|Sign in/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  const failures: [string, DirectStatus | Error, RegExp, boolean][] = [
    ['not yaran', { kind: 'not_yaran' }, /not like yaran/, true],
    ['Access in front', { kind: 'access_required' }, /behind Cloudflare Access/, false],
    ['a redirect', { kind: 'redirected' }, /sent the app somewhere else/, true],
    ['a TLS error', { kind: 'tls_error' }, /isn't secure/, false],
    ['an org host natively', { kind: 'refused', reason: 'org_host' }, /belongs to an org/, false],
    ['a locked vault', { kind: 'vault_locked' }, /Unlock the app/, true],
    ['a native rejection', Object.assign(new Error('boom'), { code: 'native_error' }), /native_error/, true],
  ];
  for (const [name, answer, text, retry] of failures) {
    it(`says why on ${name} and offers retry only when it can help`, async () => {
      if (answer instanceof Error) vi.mocked(Session.directStatus).mockRejectedValue(answer);
      else vi.mocked(Session.directStatus).mockResolvedValue(answer);
      renderShell(<ConfirmMachine host={HOST} />);
      expect((await screen.findByRole('alert')).textContent).toMatch(text);
      expect(screen.queryByRole('button', { name: 'Try again' }) !== null).toBe(retry);
      expect(screen.queryByRole('button', { name: 'Add machine' })).toBeNull();
    });
  }

  it('refuses a host an org already lists, loading the org list first', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    vi.mocked(Session.request).mockResolvedValue({ kind: 'ok', status: 200, body: { items: [{ ...MACHINE, url: 'https://laptop-ada.example.com', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' }], next_cursor: null } });
    renderShell(<ConfirmMachine host="laptop-ada.example.com" />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/belongs to Ada Org/);
    expect(Session.directStatus).not.toHaveBeenCalled();
  });

  it('refuses an invalid host from a link before contacting anything', async () => {
    renderShell(<ConfirmMachine host="10.0.0.1" />);
    expect(screen.getByRole('alert').textContent).toMatch(/isn't valid/);
    expect(Session.directStatus).not.toHaveBeenCalled();
  });
});

describe('the Direct section', () => {
  it('opens a direct machine, signs in again and confirms removal', async () => {
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByText(HOST));
    await waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ kind: 'direct', host: HOST, instance: 'inst-1' }));

    vi.mocked(Session.directSignIn).mockResolvedValueOnce({ kind: 'signed_in', host: HOST, instance: 'inst-1', signInId: 'sid-1' });
    fireEvent.click(screen.getByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign in again/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(directStore.get().machines).toEqual([]));
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST });
    expect(r.id).toBeTruthy();
  });

  it('keeps the machine and says so when removal cannot sign out', async () => {
    await addDirect({ host: HOST, instance: null });
    vi.mocked(Session.directSignOut).mockResolvedValueOnce({ kind: 'vault_locked' });
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(directStore.get().machines).toHaveLength(1);
  });
});

describe('Remove and Sign in again on one machine, in either order', () => {
  const menu = async (item: RegExp) => {
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  };
  const order = () =>
    [...vi.mocked(Session.directSignIn).mock.invocationCallOrder.map((n) => [n, 'in'] as const), ...vi.mocked(Session.directSignOut).mock.invocationCallOrder.map((n) => [n, 'out'] as const)]
      .sort((a, b) => a[0] - b[0])
      .map(([, w]) => w);

  it('Remove first: the queued Sign in again finds it gone and signs nothing in', async () => {
    await addDirect({ host: HOST, instance: null });
    let out!: () => void;
    vi.mocked(Session.directSignOut).mockImplementationOnce(() => new Promise((r) => (out = () => r({ kind: 'signed_out', serverEnded: true }))));
    renderShell(<MachineList />);
    await menu(/Remove/);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(Session.directSignOut).toHaveBeenCalled());
    await menu(/Sign in again/);
    out();
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(Session.directSignIn).not.toHaveBeenCalled();
    expect(directStore.get().machines).toEqual([]);
  });

  it('Sign in again first: the Remove queued behind it ends that new session too', async () => {
    await addDirect({ host: HOST, instance: null });
    let done!: () => void;
    vi.mocked(Session.directSignIn).mockImplementationOnce(() => new Promise((r) => (done = () => r({ kind: 'signed_in', host: HOST, instance: null, signInId: 'sid-2' }))));
    renderShell(<MachineList />);
    await menu(/Sign in again/);
    await waitFor(() => expect(Session.directSignIn).toHaveBeenCalled());
    await menu(/Remove/);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove machine' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(Session.directSignOut).not.toHaveBeenCalled();
    done();
    await waitFor(() => expect(directStore.get().machines).toEqual([]));
    expect(order()).toEqual(['in', 'out']);
  });
});

describe('a host-only sign-out answered not_current: a newer sign-in survived', () => {
  /** Native keeps sign-in D and answers not_current to a sign-out without an id. */
  const nativeKeepsD = () => {
    const native = { current: 'D' as string | null };
    vi.mocked(Session.directSignOut).mockImplementation(async ({ signInId }) => (signInId === undefined && native.current === 'D' ? { kind: 'not_current' } : { kind: 'signed_out', serverEnded: true }));
    return native;
  };
  const said = () => renderShell(<>{vi.mocked(toast.error).mock.calls.at(-1)![0] as ReactNode}</>).container.textContent;
  afterEach(() => vi.mocked(Session.directSignOut).mockImplementation(async () => ({ kind: 'signed_out', serverEnded: true })));

  it('Remove machine keeps the machine on disk and in memory, and says it is still on this phone', async () => {
    const native = nativeKeepsD();
    await addDirect({ host: HOST, instance: null });
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Remove/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST });
    expect(native.current).toBe('D');
    expect(directStore.get().machines.map((m) => m.host)).toEqual([HOST]);
    expect(JSON.parse(vault.get('direct/list')!).map((m: { host: string }) => m.host)).toEqual([HOST]);
    expect(said()).toMatch(/not_current.*still on this phone/);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('removing a typed route keeps the route on disk and in memory, and says so', async () => {
    const native = nativeKeepsD();
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    await updateDirect(r.id, (c) => ({ routes: [...c.routes, { kind: 'direct', host: 'box.example.com' }] }));
    renderShell(<MachineRoutes id={r.id} />);
    const removeButtons = await screen.findAllByRole('button', { name: 'Remove this way' });
    fireEvent.click(removeButtons.at(-1)!);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: 'box.example.com' });
    expect(native.current).toBe('D');
    expect(directStore.get().machines[0]!.routes.map((x) => x.host)).toEqual([HOST, 'box.example.com']);
    expect(JSON.parse(vault.get('direct/list')!)[0].routes.map((x: { host: string }) => x.host)).toEqual([HOST, 'box.example.com']);
    expect(said()).toMatch(/not_current.*route stays/);
  });
});

describe('MachineRoutes', () => {
  it('adds a typed route only when it answers as the same instance', async () => {
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    renderShell(<MachineRoutes id={r.id} />);
    const field = await screen.findByLabelText('Another HTTPS address');
    vi.mocked(Session.directStatus).mockResolvedValueOnce(yaran({ instance: 'someone-else' }));
    fireEvent.change(field, { target: { value: 'box.example.com' } });
    fireEvent.submit(field.closest('form')!);
    expect(await screen.findByText(/A different yaran answers at/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add this way' })).toBeNull();

    vi.mocked(Session.directStatus).mockResolvedValueOnce(yaran());
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add this way' }));
    await waitFor(() => expect(directStore.get().machines[0]!.routes).toEqual([{ kind: 'direct', host: HOST }, { kind: 'direct', host: 'box.example.com' }]));
  });

  it('refuses an address already used on this phone without probing it', async () => {
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    orgStore.set({ loaded: true, orgs: [ORG] });
    renderShell(<MachineRoutes id={r.id} />);
    const field = await screen.findByLabelText('Another HTTPS address');
    fireEvent.change(field, { target: { value: 'cp.example.com' } });
    fireEvent.submit(field.closest('form')!);
    expect(screen.getByRole('alert').textContent).toMatch(/already used on this phone/);
    expect(Session.directStatus).not.toHaveBeenCalled();
  });

  it('adds an org machine, reorders, and removes a typed route after signing it out', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE], fetchedAt: 0 } });
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    await updateDirect(r.id, () => ({ routes: [...r.routes, { kind: 'direct', host: 'box.example.com' }] }));
    vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran());
    renderShell(<MachineRoutes id={r.id} />);
    fireEvent.click(await screen.findByRole('button', { name: /Add laptop through Ada Org/ }));
    await waitFor(() => expect(directStore.get().machines[0]!.routes).toHaveLength(3));
    expect(Session.routeStatus).toHaveBeenCalledWith({ route: { kind: 'org', orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[2]!);
    await waitFor(() => expect(directStore.get().machines[0]!.routes[1]!.kind).toBe('org'));
    // The machine's own address cannot be removed here; the typed one can.
    expect(screen.getAllByRole('button', { name: 'Remove this way' })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove this way' })[1]!);
    await waitFor(() => expect(directStore.get().machines[0]!.routes.map((x) => x.host)).toEqual([HOST, MACHINE.hostname]));
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: 'box.example.com' });
  });

  describe('checking an org route before saving it', () => {
    const ORG_ROUTE = { kind: 'org', orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname };
    async function setUp() {
      orgStore.set({ loaded: true, orgs: [ORG] });
      machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE], fetchedAt: 0 } });
      vi.mocked(Session.routeStatus).mockReset();
      return addDirect({ host: HOST, instance: 'inst-1' });
    }
    const routes = () => directStore.get().machines[0]?.routes.map((x) => x.host);

    it('signs in to that machine when the route has no session, probes again and saves on a match', async () => {
      const r = await setUp();
      vi.mocked(Session.routeStatus).mockResolvedValueOnce({ kind: 'sign_in_required' }).mockResolvedValueOnce(yaran());
      vi.mocked(Session.signIn).mockResolvedValueOnce({ kind: 'signed_in', host: MACHINE.hostname, email: 'a@example.com', expiresAt: 1 });
      expect((await addCheckedOrgRoute(r.id, ORG.id, MACHINE)).tone).toBe('success');
      expect(Session.signIn).toHaveBeenCalledWith({ orgId: ORG.id, target: { machineHost: MACHINE.hostname } });
      expect(Session.routeStatus).toHaveBeenCalledTimes(2);
      expect(directStore.get().machines[0]!.routes).toEqual([{ kind: 'direct', host: HOST }, ORG_ROUTE]);
    });

    it('saves nothing when the sign-in does not finish, the route answers as another machine, or the probe fails', async () => {
      const r = await setUp();
      vi.mocked(Session.routeStatus).mockResolvedValueOnce({ kind: 'sign_in_required' });
      vi.mocked(Session.signIn).mockResolvedValueOnce({ kind: 'secure_storage_failed' });
      expect((await addCheckedOrgRoute(r.id, ORG.id, MACHINE)).tone).toBe('error');
      expect(Session.routeStatus).toHaveBeenCalledTimes(1);
      vi.mocked(Session.routeStatus).mockResolvedValueOnce({ kind: 'sign_in_required' }).mockResolvedValueOnce({ kind: 'sign_in_required' });
      vi.mocked(Session.signIn).mockResolvedValueOnce({ kind: 'signed_in', host: MACHINE.hostname, email: 'a@example.com', expiresAt: 1 });
      expect((await addCheckedOrgRoute(r.id, ORG.id, MACHINE)).tone).toBe('error');
      vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran({ instance: 'impostor' }));
      expect((await addCheckedOrgRoute(r.id, ORG.id, MACHINE)).tone).toBe('error');
      vi.mocked(Session.routeStatus).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'native_error' }));
      expect((await addCheckedOrgRoute(r.id, ORG.id, MACHINE)).tone).toBe('error');
      expect(routes()).toEqual([HOST]);
    });

    const races: [string, () => Promise<void>][] = [
      ['the machine was removed', async () => directStore.set({ loaded: true, machines: [] })],
      ['the org was signed out', async () => orgStore.set({ loaded: true, orgs: [] })],
      ['the org list dropped the machine', async () => machinesStore.set({ [ORG.id]: { state: 'ready', machines: [], fetchedAt: 0 } })],
      ['the identity changed', async () => void (await updateDirect(directStore.get().machines[0]!.id, () => ({ instance: 'inst-2' })))],
      [
        'the route cap filled',
        async () => {
          const id = directStore.get().machines[0]!.id;
          await updateDirect(id, () => ({ routes: [{ kind: 'direct', host: HOST }, { kind: 'direct', host: 'b.example.com' }, { kind: 'direct', host: 'c.example.com' }, { kind: 'direct', host: 'd.example.com' }] }));
        },
      ],
      ['another screen added it', async () => void await updateDirect(directStore.get().machines[0]!.id, () => ({ routes: [{ kind: 'direct', host: HOST }, ORG_ROUTE as never] }))],
    ];
    for (const [name, change] of races) {
      it(`re-reads after the probe: refuses when ${name} meanwhile`, async () => {
        const r = await setUp();
        let answer!: (s: DirectStatus) => void;
        vi.mocked(Session.routeStatus).mockReturnValueOnce(new Promise((res) => (answer = res)));
        const pending = addCheckedOrgRoute(r.id, ORG.id, MACHINE);
        await change();
        const before = JSON.stringify(directStore.get());
        answer(yaran());
        expect((await pending).tone).toBe('error');
        expect(JSON.stringify(directStore.get())).toBe(before);
      });
    }
  });

  it('offers no new route for a machine without an identity', async () => {
    const r = await addDirect({ host: HOST, instance: null });
    renderShell(<MachineRoutes id={r.id} />);
    expect(await screen.findByText(/doesn't report an identity/)).toBeTruthy();
    expect(screen.queryByLabelText('Another HTTPS address')).toBeNull();
  });
});

describe('ShareTarget', () => {
  it('lists org and direct machines with the held count and opens the pick with the share', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE], fetchedAt: 0 } });
    await addDirect({ host: HOST, instance: 'inst-1' });
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 2, batch: 'share-2' });
    renderShell(<ShareTarget />);
    expect(await screen.findByRole('heading', { name: 'Send 2 files to…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: HOST }));
    await waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ kind: 'direct', host: HOST, instance: 'inst-1', shareBatch: 'share-2' }));
    expect(route()).toEqual({ name: 'machines' });
  });

  it('says the files are gone on no_share, and Cancel discards natively', async () => {
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [MACHINE], fetchedAt: 0 } });
    vi.mocked(MachineView.shareStatus).mockResolvedValueOnce({ kind: 'pending', count: 1, batch: 'share-1' }).mockResolvedValueOnce({ kind: 'none' });
    vi.mocked(MachineView.open).mockRejectedValueOnce(Object.assign(new Error('none held'), { code: 'no_share' }));
    renderShell(<ShareTarget />);
    fireEvent.click(await screen.findByRole('button', { name: 'laptop' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE.id, host: MACHINE.hostname, shareBatch: 'share-1' });
    expect(await screen.findByText('No shared files are waiting.')).toBeTruthy();

    shareStore.set({ kind: 'pending', count: 1, batch: 'share-1' });
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 1, batch: 'share-1' });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel and discard' }));
    await waitFor(() => expect(MachineView.discardShare).toHaveBeenCalledWith({ batch: 'share-1' }));
    expect(route()).toEqual({ name: 'machines' });
  });

  it('a failed discard keeps the files and says so', async () => {
    vi.mocked(MachineView.shareStatus).mockResolvedValue({ kind: 'pending', count: 1, batch: 'share-1' });
    vi.mocked(MachineView.discardShare).mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'native_error' }));
    renderShell(<ShareTarget />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel and discard' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(shareStore.get()).toEqual({ kind: 'pending', count: 1, batch: 'share-1' });
  });
});
