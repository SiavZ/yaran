/**
 * DOM tests for the Machines screen, its row menu and the remove dialog.
 *
 * Covers: every `MachineStatus` plus an unknown value renders a word; grouping with more than
 * one org; Open hands off to MachineView; the remove dialog autofocuses Cancel and names the
 * machine as a chip; success raises a toast; a 404 raises an info toast and refreshes; an
 * expired session shows the sign-in prompt; `device_revoked` removes the org and shows the
 * phone-removed route.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/machines.test.tsx
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/i18n.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRow.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, node:fs, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { readFileSync } from 'node:fs';

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MachineSummary } from '@yaran/protocol';
import { SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../lib/i18n.ts';
import { resetMachines } from '../../lib/machinesStore.ts';
import { MachineView, Session, type ApiResult } from '../../lib/native/machineView.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { renderShell } from '../../test/render.tsx';
import { MachineList } from './MachineList.tsx';
import { statusLook } from './MachineRow.tsx';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = { id: 'https://cp.example.com', name: 'Ada Org', teamDomain: null, addedAt: 'x' };
const machine = (over: Partial<MachineSummary> = {}): MachineSummary => ({
  id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
  name: 'laptop',
  hostname: 'laptop-ada.example.com',
  url: 'https://laptop-ada.example.com',
  status: 'online',
  status_checked_at: '2026-11-14T12:00:00Z',
  paired_at: '2026-11-14T12:00:00Z',
  ...over,
});
const page = (items: MachineSummary[]): ApiResult => ({ kind: 'ok', status: 200, body: { items, next_cursor: null } });
const request = vi.mocked(Session.request);
const indexCss = readFileSync('src/index.css', 'utf8'); // vitest runs from mobile/app

beforeEach(() => {
  resetMachines();
  orgStore.set({ loaded: true, orgs: [ORG] });
  request.mockReset();
});

async function openRemove() {
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for laptop' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: /Remove…/ }));
  return screen.findByRole('dialog');
}

describe('statusLook', () => {
  it('has a word for every status and for an unknown one', () => {
    for (const s of ['online', 'degraded', 'offline', 'never_connected', 'provisioning', 'tearing_down', 'unknown', 'from_the_future']) {
      expect(i18n._(statusLook(s).word).length).toBeGreaterThan(3);
    }
    expect(i18n._(statusLook('from_the_future').word)).toBe('Status unknown');
  });
});

describe('MachineList', () => {
  it('lists machines and opens one through MachineView', async () => {
    request.mockResolvedValue(page([machine()]));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByText('laptop'));
    await waitFor(() =>
      expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: machine().id, host: 'laptop-ada.example.com' }),
    );
  });

  // The reported device path: the row's ⋯ menu, then Open.
  it('opens a machine from the actions menu', async () => {
    request.mockResolvedValue(page([machine()]));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for laptop' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open/ }));
    await waitFor(() =>
      expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: machine().id, host: 'laptop-ada.example.com' }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when the native window refuses to open, instead of doing nothing', async () => {
    request.mockResolvedValue(page([machine()]));
    vi.mocked(MachineView.open).mockRejectedValueOnce(Object.assign(new Error('orgId, machineId, host or route is invalid'), { code: 'invalid_arguments' }));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for laptop' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toContain('invalid_arguments');
  });

  it('still opens when remembering the last machine fails', async () => {
    request.mockResolvedValue(page([machine()]));
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('vault locked'), { code: 'vault_locked' }));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for laptop' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Open/ }));
    await waitFor(() => expect(MachineView.open).toHaveBeenCalledTimes(1));
  });

  it('shows an error instead of loading forever when the native list call rejects', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('the vault is locked'), { code: 'vault_locked' }));
    renderShell(<MachineList />);
    expect(await screen.findByText('Unlock the app, then try again.')).toBeTruthy();
    request.mockResolvedValue(page([machine()]));
    fireEvent.click(screen.getByRole('button', { name: /Try again|Retry/ }));
    expect(await screen.findByText('laptop')).toBeTruthy();
  });

  it('groups by org when more than one org is added', async () => {
    orgStore.set({ loaded: true, orgs: [ORG, { ...ORG, id: 'https://cp2.example.com', name: 'Babbage Org' }] });
    request.mockResolvedValue(page([machine()]));
    renderShell(<MachineList />);
    expect(await screen.findByRole('heading', { name: 'Ada Org' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Babbage Org' })).toBeTruthy();
  });

  it('the remove dialog autofocuses Cancel and names the machine as a chip', async () => {
    request.mockResolvedValue(page([machine()]));
    renderShell(<MachineList />);
    const dialog = await openRemove();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })));
    expect(dialog.querySelector('[data-slot="inline-code"]')?.textContent).toBe('laptop');
  });

  it('the action sheet names the machine its actions act on', async () => {
    request.mockResolvedValue(page([machine()]));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for laptop' }));
    const group = await screen.findByRole('group', { name: 'laptop' });
    expect(within(group).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Open', 'Remove…']);
  });

  it('pins a scrolling dialog footer, so the focused Cancel is never clipped at enlarged text', () => {
    // Layout is not measurable in jsdom; the browser check is in the round's evidence. This holds the rule.
    expect(indexCss).toMatch(/\[data-slot="dialog-content"\] > \[data-slot="dialog-footer"\] \{ position: sticky; bottom: -1rem;/);
  });

  it('a remove success raises a toast', async () => {
    request.mockResolvedValueOnce(page([machine()]));
    renderShell(<MachineList />);
    const dialog = await openRemove();
    request.mockResolvedValueOnce({ kind: 'ok', status: 202, body: { machine_id: machine().id, state: 'tearing_down' } });
    request.mockResolvedValue(page([]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('a 404 on remove raises an info toast and refreshes', async () => {
    request.mockResolvedValueOnce(page([machine()]));
    renderShell(<MachineList />);
    const dialog = await openRemove();
    request.mockResolvedValueOnce({ kind: 'api_error', status: 404, error: { error: { code: 'not_found', message: 'x', retryable: false }, request_id: 'r' } });
    request.mockResolvedValue(page([]));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove machine' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  });

  it('an expired session shows the sign-in prompt', async () => {
    request.mockResolvedValue({ kind: 'session_expired' });
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(Session.signIn).toHaveBeenCalledWith({ orgId: ORG.id, target: 'control-plane' });
  });

  it('keeps a failed renewal visible and lets the user retry it', async () => {
    request.mockResolvedValue({ kind: 'session_expired' });
    vi.mocked(Session.signIn).mockResolvedValueOnce({ kind: 'cancelled' }).mockResolvedValueOnce({ kind: 'offline' });
    renderShell(<MachineList />);
    const signIn = await screen.findByRole('button', { name: 'Sign in' });
    signIn.focus();
    fireEvent.click(signIn);
    const failure = await screen.findByText('Sign-in was cancelled.');
    await waitFor(() => expect(document.activeElement).toBe(failure.parentElement));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const offline = await screen.findByText(/No connection/);
    await waitFor(() => expect(document.activeElement).toBe(offline.parentElement));
  });

  it('prevents another renewal while the browser is opening', async () => {
    request.mockResolvedValue({ kind: 'session_expired' });
    let finish!: (outcome: { kind: 'cancelled' }) => void;
    vi.mocked(Session.signIn).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const pending = await screen.findByRole('button', { name: 'Opening browser…' });
    expect(pending.hasAttribute('disabled')).toBe(true);
    fireEvent.click(pending);
    finish({ kind: 'cancelled' });
    expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy();
  });

  it('offers org management after a non-retryable renewal failure without nesting alerts', async () => {
    request.mockResolvedValue({ kind: 'session_expired' });
    vi.mocked(Session.signIn).mockResolvedValueOnce({ kind: 'tls_error' });
    renderShell(<MachineList />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const manage = await screen.findByRole('button', { name: 'Manage orgs' });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(manage);
    expect(parseRoute(window.location.hash)).toEqual({ name: 'orgs' });
  });

  it('device_revoked removes the org and shows the phone-removed screen', async () => {
    request.mockResolvedValue({ kind: 'device_revoked' });
    renderShell(<MachineList />);
    await waitFor(() => expect(parseRoute(window.location.hash)).toEqual({ name: 'removed', org: 'Ada Org' }));
    expect(orgStore.get().orgs).toEqual([]);
  });

  it('shows the cloud login hint for an org with no machines', async () => {
    request.mockResolvedValue(page([]));
    renderShell(<MachineList />);
    expect(await screen.findByText('yaran cloud login')).toBeTruthy();
  });
});
