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
 * ├── src/lib/i18n.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/machines/MachineList.tsx
 * ├── src/screens/machines/MachineRow.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { MachineSummary } from '@yaran/protocol';
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
