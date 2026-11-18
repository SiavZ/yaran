/**
 * A direct window that closes on its own codes: `instance_changed` is tied to one record only by
 * the close event's own `host` and `requestedHost` (never by which machine opened last), an
 * untrusted context offers nothing destructive, and `no_route` says none of the ways answered.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/instanceChanged.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import type { ReactNode } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../../App.tsx';
import { addDirect, directStore, updateDirect } from '../../lib/directStore.ts';
import { vault } from '../../test/setup.ts';
import type { MachineSummary } from '@yaran/protocol';
import { machinesStore, resetMachines } from '../../lib/machinesStore.ts';
import { MachineView, Session, type DirectStatus } from '../../lib/native/machineView.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { openDirect } from '../../lib/openMachine.ts';
import { renderShell } from '../../test/render.tsx';

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

describe('a direct window that closes on its own codes', () => {
  async function closedListener() {
    window.location.hash = '#/machines';
    renderShell(<App />);
    const calls = () => vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    await waitFor(() => expect(calls().some((c) => c[0] === 'closed')).toBe(true));
    return calls().find((c) => c[0] === 'closed')![1];
  }

  it('instance_changed asks first; Keep re-reads that route, saves it and opens again', async () => {
    await addDirect({ host: HOST, instance: 'inst-1' });
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'instance_changed', host: HOST, requestedHost: HOST }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Not now' })));
    expect(directStore.get().machines[0]!.instance).toBe('inst-1');
    vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran({ instance: 'inst-2' }));
    vi.mocked(MachineView.open).mockClear();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(MachineView.open).toHaveBeenCalledWith({ kind: 'direct', host: HOST, instance: 'inst-2' }));
    expect(Session.routeStatus).toHaveBeenCalledWith({ route: { kind: 'direct', host: HOST } });
    expect(directStore.get().machines[0]!.instance).toBe('inst-2');
  });

  it('a late close for A after B was opened names and removes A, never B', async () => {
    const a = await addDirect({ host: HOST, instance: 'inst-a' });
    const b = await addDirect({ host: 'other.tail1.ts.net', instance: 'inst-b' });
    await openDirect(a.id);
    await openDirect(b.id);
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'instance_changed', host: HOST, requestedHost: HOST }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(HOST);
    expect(dialog.textContent).not.toContain('other.tail1.ts.net');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(directStore.get().machines.map((m) => m.id)).toEqual([b.id]));
    expect(Session.directSignOut).toHaveBeenCalledWith({ host: HOST });
    expect(Session.directSignOut).not.toHaveBeenCalledWith({ host: 'other.tail1.ts.net' });
  });

  it('a close on an alternative route is tied to the record that owns both hosts', async () => {
    const a = await addDirect({ host: HOST, instance: 'inst-a' });
    await updateDirect(a.id, (cur) => ({ routes: [...cur.routes, { kind: 'direct', host: 'box.example.com' }] }));
    await addDirect({ host: 'other.tail1.ts.net', instance: 'inst-b' });
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'instance_changed', host: 'box.example.com', requestedHost: HOST }));
    expect((await screen.findByRole('dialog')).textContent).toContain('box.example.com');
  });

  const untrusted: [string, object][] = [
    ['no context', {}],
    ['only a host', { host: HOST }],
    ['hosts of two different machines', { host: HOST, requestedHost: 'other.tail1.ts.net' }],
    ['an unknown host', { host: 'stranger.example.com', requestedHost: 'stranger.example.com' }],
  ];
  for (const [name, context] of untrusted) {
    it(`a close with ${name} offers nothing destructive`, async () => {
      await addDirect({ host: HOST, instance: 'inst-a' });
      await addDirect({ host: 'other.tail1.ts.net', instance: 'inst-b' });
      const closed = await closedListener();
      act(() => closed({ reason: 'error', code: 'instance_changed', ...context }));
      await waitFor(() => expect(String(vi.mocked(toast.warning).mock.calls.at(-1)?.[0])).toMatch(/A different yaran answered/));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(directStore.get().machines).toHaveLength(2);
    });
  }

  it('no_route says none of the ways answered', async () => {
    const closed = await closedListener();
    act(() => closed({ reason: 'error', code: 'no_route' }));
    await waitFor(() => expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).toMatch(/None of the ways to reach/));
  });
});

describe('Keep on an org route checks the route as it is now', () => {
  const ORG = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' };
  const MID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const at = (hostname: string) => machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MID, name: 'laptop', hostname } as MachineSummary], fetchedAt: 0 } });

  async function dialogOnOrgRoute() {
    resetMachines();
    orgStore.set({ loaded: true, orgs: [ORG] });
    at('a.example.com');
    const r = await addDirect({ host: HOST, instance: 'inst-1' });
    await updateDirect(r.id, (c) => ({ routes: [...c.routes, { kind: 'org', orgId: ORG.id, machineId: MID, host: 'a.example.com' }] }));
    window.location.hash = '#/machines';
    renderShell(<App />);
    const calls = () => vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    await waitFor(() => expect(calls().some((c) => c[0] === 'closed')).toBe(true));
    act(() => calls().find((c) => c[0] === 'closed')![1]({ reason: 'error', code: 'instance_changed', host: 'a.example.com', requestedHost: HOST }));
    return { id: r.id, dialog: await screen.findByRole('dialog') };
  }
  const orgRoute = (host: string) => ({ route: { kind: 'org', orgId: ORG.id, machineId: MID, host } });

  it('a machine that moved to another host before Keep is probed at its new host', async () => {
    const { dialog } = await dialogOnOrgRoute();
    at('b.example.com');
    vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran({ instance: 'inst-2' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(directStore.get().machines[0]!.instance).toBe('inst-2'));
    expect(Session.routeStatus).toHaveBeenCalledWith(orgRoute('b.example.com'));
    expect(Session.routeStatus).not.toHaveBeenCalledWith(orgRoute('a.example.com'));
  });

  const closeAgain = () => {
    const calls = vi.mocked(MachineView.addListener).mock.calls as unknown as [string, (e: unknown) => void][];
    act(() => calls.find((c) => c[0] === 'closed')![1]({ reason: 'error', code: 'instance_changed', host: 'a.example.com', requestedHost: HOST }));
  };
  const said = () => renderShell(<>{vi.mocked(toast.error).mock.calls.at(-1)![0] as ReactNode}</>).container.textContent;

  it('a newer Keep that already saved wins over an older one still checking', async () => {
    const { dialog } = await dialogOnOrgRoute();
    let older!: (s: DirectStatus) => void;
    vi.mocked(Session.routeStatus).mockReturnValueOnce(new Promise((r) => (older = r)));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(Session.routeStatus).toHaveBeenCalledTimes(1));
    closeAgain();
    vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran({ instance: 'inst-2' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Keep and open' }));
    await waitFor(() => expect(directStore.get().machines[0]!.instance).toBe('inst-2'));
    // The newer Keep is a newer choice: the older one ends without a word and changes nothing.
    vi.mocked(toast.error).mockClear();
    older(yaran({ instance: 'inst-3' }));
    await new Promise((r) => setTimeout(r, 30));
    expect(toast.error).not.toHaveBeenCalled();
    expect(directStore.get().machines[0]!.instance).toBe('inst-2');
  });

  const duringWrite: [string, () => void][] = [
    ['moves to another host', () => at('b.example.com')],
    ['leaves its org list', () => machinesStore.set({ [ORG.id]: { state: 'ready', machines: [], fetchedAt: 0 } })],
  ];
  for (const [name, change] of duringWrite) {
    it(`a route that ${name} while the identity is being written is undone and not opened`, async () => {
      const { dialog } = await dialogOnOrgRoute();
      vi.mocked(Session.routeStatus).mockResolvedValueOnce(yaran({ instance: 'inst-2' }));
      const real = vi.mocked(SecureStore.set).getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
      vi.mocked(MachineView.open).mockClear();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
      await waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
      change();
      release();
      await waitFor(() => expect(said()).toMatch(/changed while the app was checking/));
      expect(directStore.get().machines[0]!.instance).toBe('inst-1');
      expect(JSON.parse(vault.get('direct/list')!)[0].instance).toBe('inst-1');
      expect(MachineView.open).not.toHaveBeenCalled();
    });
  }

  const meanwhile: [string, (id: string) => Promise<unknown> | void][] = [
    ['moves to another host', () => at('b.example.com')],
    ['is removed from the machine', (id) => updateDirect(id, (c) => ({ routes: c.routes.filter((x) => x.kind === 'direct') }))],
    ['leaves its org list', () => machinesStore.set({ [ORG.id]: { state: 'ready', machines: [], fetchedAt: 0 } })],
  ];
  for (const [name, change] of meanwhile) {
    it(`a route that ${name} while the probe waits saves nothing and opens nothing`, async () => {
      const { id, dialog } = await dialogOnOrgRoute();
      let answer!: (s: DirectStatus) => void;
      vi.mocked(Session.routeStatus).mockReturnValueOnce(new Promise((r) => (answer = r)));
      vi.mocked(MachineView.open).mockClear();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep and open' }));
      await waitFor(() => expect(Session.routeStatus).toHaveBeenCalledWith(orgRoute('a.example.com')));
      await change(id);
      answer(yaran({ instance: 'inst-2' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      const said = renderShell(<>{vi.mocked(toast.error).mock.calls.at(-1)![0] as ReactNode}</>).container.textContent;
      expect(said).toMatch(/changed while the app was checking/);
      expect(directStore.get().machines[0]!.instance).toBe('inst-1');
      expect(MachineView.open).not.toHaveBeenCalled();
    });
  }
});
