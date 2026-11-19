/**
 * A machine whose yaran predates the app's own sign-in (`upgrade_required`): every surface says
 * to update yaran on that machine and offers a retry, nothing is saved, nothing is removed, and
 * a window that closes with it never raises the instance-changed dialog.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/upgradeRequired.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRoutes.tsx
 * ├── src/screens/onboarding/ConfirmMachine.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MachineSummary } from '@yaran/protocol';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App.tsx';
import { addDirect, directStore } from '../../lib/directStore.ts';
import { resetMachines } from '../../lib/machinesStore.ts';
import { MachineView, Session, type DirectStatus } from '../../lib/native/machineView.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { renderShell } from '../../test/render.tsx';
import { ConfirmMachine } from '../onboarding/ConfirmMachine.tsx';
import { MachineList } from './MachineList.tsx';
import { addCheckedOrgRoute } from './MachineRoutes.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const HOST = 'box.tail1.ts.net';
const UPDATE = /too old for this app.*Update yaran on that machine/;
const UPGRADE = { kind: 'upgrade_required' } as const;
const yaran = (over: Partial<Extract<DirectStatus, { kind: 'yaran' }>> = {}): DirectStatus => ({
  kind: 'yaran',
  instance: 'inst-1',
  passwordSet: true,
  requiredHere: false,
  signedIn: false,
  transportEncrypted: true,
  ...over,
});
const said = (tone: 'error' | 'warning') => renderShell(<>{vi.mocked(toast[tone]).mock.calls.at(-1)![0] as ReactNode}</>).container.textContent;

beforeEach(() => {
  resetMachines();
  orgStore.set({ loaded: true, orgs: [] });
  vi.mocked(Session.directStatus).mockReset();
  vi.mocked(Session.directSignIn).mockReset();
  vi.mocked(Session.routeStatus).mockReset();
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
});

describe('a window closed with upgrade_required', () => {
  async function closedListener() {
    window.location.hash = '#/settings';
    renderShell(<App />);
    const calls = () => vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    await waitFor(() => expect(calls().some((c) => c[0] === 'closed')).toBe(true));
    return calls().find((c) => c[0] === 'closed')![1];
  }

  it('names the machine, says to update it, keeps every record and asks nothing', async () => {
    await addDirect({ host: HOST, instance: 'inst-1' });
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'upgrade_required', host: HOST, requestedHost: HOST }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(said('warning')).toMatch(UPDATE);
    expect(said('warning')).toContain(HOST);
    expect(said('warning')).not.toMatch(/different yaran/);
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(parseRoute(window.location.hash)).toEqual({ name: 'machines' });
    expect(directStore.get().machines.map((m) => [m.host, m.instance])).toEqual([[HOST, 'inst-1']]);
  });

  it('with no host named (an org window), says the same without one', async () => {
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'upgrade_required' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1));
    expect(said('warning')).toMatch(/That machine's yaran is too old.*Update yaran on that machine, then open it again/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a status check or sign-in answered upgrade_required', () => {
  it('adding: the status check says to update, offers Try again, and adds nothing', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(UPGRADE);
    renderShell(<ConfirmMachine host={HOST} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(UPDATE);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add machine|Sign in/ })).toBeNull();
    expect(Session.directSignIn).not.toHaveBeenCalled();
    expect(directStore.get().machines).toEqual([]);
  });

  it('adding: the sign-in says to update, offers Try again, and adds nothing', async () => {
    vi.mocked(Session.directStatus).mockResolvedValue(yaran({ requiredHere: true }));
    vi.mocked(Session.directSignIn).mockResolvedValue(UPGRADE);
    renderShell(<ConfirmMachine host={HOST} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in and continue' }));
    await waitFor(() => expect(document.body.textContent).toMatch(UPDATE));
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(directStore.get().machines).toEqual([]);
  });

  it('Sign in again on a listed machine says to update and keeps it', async () => {
    await addDirect({ host: HOST, instance: 'inst-1' });
    vi.mocked(Session.directSignIn).mockResolvedValue(UPGRADE);
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${HOST}` }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Sign in again/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(said('error')).toMatch(UPDATE);
    expect(directStore.get().machines).toHaveLength(1);
  });

  it('Keep after an instance change probes upgrade_required: says to update and keeps the old identity', async () => {
    await addDirect({ host: HOST, instance: 'inst-1' });
    window.location.hash = '#/machines';
    renderShell(<App />);
    const calls = () => vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    await waitFor(() => expect(calls().some((c) => c[0] === 'closed')).toBe(true));
    act(() => calls().find((c) => c[0] === 'closed')![1]({ reason: 'error', code: 'instance_changed', host: HOST, requestedHost: HOST }));
    const dialog = await screen.findByRole('dialog');
    vi.mocked(Session.routeStatus).mockResolvedValueOnce(UPGRADE);
    vi.mocked(MachineView.open).mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(said('error')).toMatch(UPDATE);
    expect(MachineView.open).not.toHaveBeenCalled();
    expect(directStore.get().machines.map((m) => m.instance)).toEqual(['inst-1']);
  });

  it('an org route check answered upgrade_required is refused with the update sentence and saves nothing', async () => {
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    // The route's org is on this phone (a route check refuses one that is not, before probing).
    orgStore.set({ loaded: true, orgs: [{ id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' }] });
    vi.mocked(Session.routeStatus).mockResolvedValue(UPGRADE);
    const m = { id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b', name: 'laptop', hostname: 'laptop-ada.example.com' } as MachineSummary;
    const told = await addCheckedOrgRoute(r.id, 'https://cp.example.com', m);
    expect(told.tone).toBe('error');
    expect(renderShell(<>{told.text}</>).container.textContent).toMatch(UPDATE);
    expect(directStore.get().machines[0]!.routes).toEqual([{ kind: 'direct', host: HOST }]);
  });
});
