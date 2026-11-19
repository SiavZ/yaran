/**
 * A staging's clean-up stores what is true when it publishes (round 33): an older sign-in that
 * succeeds while a newer one's clean-up is being stored moves that clean-up's fallback, and the
 * clean-up stores the corrected list in the same turn before anything is published, for a
 * deletion and for a restoration alike. When that second store fails, memory shows exactly what
 * the vault holds and the person is told the truth, never that the entry is still saved.
 *
 * <module-headers:begin>
 * Uses:
 * src/orgStagingSettle.test.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * ├── src/push/pushTestKit.ts
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SecureStore } from '@yaran/secure-store';
import { toast } from 'sonner';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetMachines } from './lib/machinesStore.ts';
import { Session } from './lib/native/machineView.ts';
import { addOrg, orgStore, ownsStaging, settleStaging, stageOrg, unstageOrg } from './lib/orgStore.ts';
import { navigate } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { meta } from './push/pushTestKit.ts';
import { renderShell } from './test/render.tsx';
import { vault } from './test/setup.ts';

vi.mock('sonner', async (orig) => ({
  ...(await orig<typeof import('sonner')>()),
  toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

const ORG = 'https://cp.example.com';
const save = async ({ namespace, key, value }: { namespace: string; key: string; value: string }) => void vault.set(`${namespace}/${key}`, value);
const names = () => orgStore.get().orgs.filter((o) => o.id === ORG).map((o) => o.name);
const stored = () => (JSON.parse(vault.get('orgs/list') ?? '[]') as { id: string; name: string }[]).filter((o) => o.id === ORG).map((o) => o.name);

/**
 * The next org-list store waits for `release`; `then` decides what each later org-list store
 * does (default: stores it).
 */
function holdNextListStore(then: () => Promise<void> | void = () => undefined) {
  let release!: () => void;
  let held = false;
  vi.mocked(SecureStore.set).mockImplementation(async (args) => {
    if (args.namespace === 'orgs') {
      if (!held) {
        held = true;
        await new Promise<void>((r) => (release = r));
      } else await then();
    }
    await save(args);
  });
  return { held: () => held, release: () => release() };
}

beforeEach(() => {
  vi.mocked(SecureStore.set).mockReset().mockImplementation(save);
  orgStore.set({ loaded: true, orgs: [] });
  vault.delete('orgs/list');
  resetMachines();
  settingsStore.set({ ...DEFAULT_SETTINGS });
  for (const t of Object.values(toast)) vi.mocked(t).mockClear();
});

describe("an older sign-in settling while the newer one's clean-up is stored", () => {
  it('a deletion: A settles while B removes the new org; the org stays with A, in memory and in the vault', async () => {
    const a = await stageOrg({ id: ORG, name: 'A', teamDomain: null });
    const b = await stageOrg({ id: ORG, name: 'B', teamDomain: null });
    const gate = holdNextListStore();
    const cleanup = unstageOrg(ORG, b.token);
    await waitFor(() => expect(gate.held()).toBe(true));
    settleStaging(ORG, a);
    gate.release();
    expect(await cleanup).toBe(true);
    expect(names()).toEqual(['A']);
    expect(stored()).toEqual(['A']);
    expect(ownsStaging(ORG, a.token) || ownsStaging(ORG, b.token)).toBe(false);
  });

  it("a restoration: A settles while B puts back the original; A's details win, in memory and in the vault", async () => {
    await addOrg({ id: ORG, name: 'Old name', teamDomain: null });
    const a = await stageOrg({ id: ORG, name: 'A', teamDomain: 'a.cloudflareaccess.com' });
    const b = await stageOrg({ id: ORG, name: 'B', teamDomain: null });
    const gate = holdNextListStore();
    const cleanup = unstageOrg(ORG, b.token);
    await waitFor(() => expect(gate.held()).toBe(true));
    settleStaging(ORG, a);
    gate.release();
    expect(await cleanup).toBe(true);
    expect(names()).toEqual(['A']);
    expect(stored()).toEqual(['A']);
    expect(orgStore.get().orgs.find((o) => o.id === ORG)?.teamDomain).toBe('a.cloudflareaccess.com');
  });

  it('control: nothing settles meanwhile; B removes the new org with one store', async () => {
    await stageOrg({ id: ORG, name: 'A', teamDomain: null });
    const b = await stageOrg({ id: ORG, name: 'B', teamDomain: null });
    vi.mocked(SecureStore.set).mockClear();
    expect(await unstageOrg(ORG, b.token)).toBe(true);
    expect(names()).toEqual([]);
    expect(vi.mocked(SecureStore.set).mock.calls.filter((c) => c[0].namespace === 'orgs')).toHaveLength(1);
  });

  it('the corrected store fails: memory shows what the vault holds, and the clean-up says fallback_unsaved', async () => {
    const a = await stageOrg({ id: ORG, name: 'A', teamDomain: null });
    const b = await stageOrg({ id: ORG, name: 'B', teamDomain: null });
    const gate = holdNextListStore(() => {
      throw Object.assign(new Error('disk full'), { code: 'native_error' });
    });
    const cleanup = unstageOrg(ORG, b.token);
    await waitFor(() => expect(gate.held()).toBe(true));
    settleStaging(ORG, a);
    gate.release();
    await expect(cleanup).rejects.toMatchObject({ code: 'fallback_unsaved' });
    // The first store (the deletion) is what the vault holds, and memory says the same.
    expect(stored()).toEqual([]);
    expect(names()).toEqual([]);
  });
});

describe('through the real App: the person is told the truth when the corrected store fails', () => {
  it('B cancelled with its store held, A signs in, the corrected store fails: one truthful error, no "still saved"', async () => {
    vi.mocked(Session.meta).mockResolvedValue({ kind: 'ok', status: 200, body: meta({ org: { name: 'New metadata', url: ORG }, access: { team_domain: 'ada.cloudflareaccess.com' } } as never) });
    let endA!: (v: unknown) => void;
    let endB!: (v: unknown) => void;
    vi.mocked(Session.signIn)
      .mockReset()
      .mockImplementationOnce(() => new Promise((r) => (endA = r)) as never)
      .mockImplementationOnce(() => new Promise((r) => (endB = r)) as never);
    window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
    renderShell(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(Session.signIn).toHaveBeenCalledTimes(1));
    act(() => navigate({ name: 'settings' }));
    await screen.findByRole('heading', { name: 'Settings' });
    act(() => navigate({ name: 'confirm', url: ORG }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(Session.signIn).toHaveBeenCalledTimes(2));
    const gate = holdNextListStore(() => {
      throw Object.assign(new Error('disk full'), { code: 'native_error' });
    });
    await act(async () => endB({ kind: 'cancelled' }));
    await waitFor(() => expect(gate.held()).toBe(true));
    await act(async () => endA({ kind: 'signed_in', host: 'cp.example.com', email: 'ada@example.com', expiresAt: 2000000000 }));
    await act(async () => gate.release());
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const said = renderShell(<>{vi.mocked(toast.error).mock.calls[0]![0] as ReactNode}</>).container.textContent;
    expect(said).toMatch(/succeeded, but the app couldn't save its details/);
    expect(said).not.toMatch(/still saved/);
    expect(names()).toEqual(stored());
  });
});
