/**
 * Org staging belongs to the sign-in that staged it (round 31), through the real App and store:
 * an older Confirm org sign-in's late answer (cancelled, failed or signed in) never removes,
 * overwrites or navigates over a newer one's staging of the same org; the owner's failure puts
 * back the durable record from before every unsettled staging; an older sign-in that succeeds
 * becomes that durable record; and a sign-out, re-add or erase meanwhile still fences it all.
 *
 * <module-headers:begin>
 * Uses:
 * src/orgStaging.test.tsx
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
 * External: @testing-library/react, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SecureStore } from '@yaran/secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { resetMachines } from './lib/machinesStore.ts';
import { Session } from './lib/native/machineView.ts';
import { addOrg, eraseEverything, orgStore, ownsStaging, removeOrgLocal, settleStaging, signOutOrg, stageOrg, unstageOrg } from './lib/orgStore.ts';
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
const SIGNED_IN = { kind: 'signed_in', host: 'cp.example.com', email: 'ada@example.com', expiresAt: 2000000000 };
const OLD = { id: ORG, name: 'Old name', teamDomain: null };
const save = async ({ namespace, key, value }: { namespace: string; key: string; value: string }) => void vault.set(`${namespace}/${key}`, value);
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const names = () => orgStore.get().orgs.filter((o) => o.id === ORG).map((o) => o.name);

beforeEach(() => {
  vi.mocked(SecureStore.set).mockReset().mockImplementation(save);
  orgStore.set({ loaded: true, orgs: [] });
  resetMachines();
  settingsStore.set({ ...DEFAULT_SETTINGS });
  vi.mocked(Session.meta).mockResolvedValue({ kind: 'ok', status: 200, body: meta({ org: { name: 'New metadata', url: ORG }, access: { team_domain: 'ada.cloudflareaccess.com' } } as never) });
});

/**
 * Starts sign-in A on Confirm, leaves through Settings, comes back and starts sign-in B for the
 * same org. Both sign-ins stay out until answered.
 */
async function twoSignInsOut(between?: () => Promise<void>) {
  let endA!: (v: unknown) => void;
  let endB!: (v: unknown) => void;
  vi.mocked(Session.signIn)
    .mockReset()
    .mockImplementationOnce(() => new Promise((r) => (endA = r)) as never)
    .mockImplementationOnce(() => new Promise((r) => (endB = r)) as never);
  window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
  const view = renderShell(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(Session.signIn).toHaveBeenCalledTimes(1));
  act(() => navigate({ name: 'settings' }));
  await screen.findByRole('heading', { name: 'Settings' });
  if (between) await between();
  act(() => navigate({ name: 'confirm', url: ORG }));
  fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(Session.signIn).toHaveBeenCalledTimes(2));
  return {
    view,
    a: async (v: unknown) => {
      await act(async () => endA(v));
      await settle();
    },
    b: async (v: unknown) => {
      await act(async () => endB(v));
      await settle();
    },
  };
}

describe('a newer sign-in owns its staging of the same org', () => {
  it.each([false, true])('a removed incarnation cannot change its replacement fallback, durable replacement: %s', async (durable) => {
    const replacement = { id: ORG, name: 'Replacement', teamDomain: 'new.cloudflareaccess.com' };
    const run = await twoSignInsOut(async () => {
      await signOutOrg(ORG);
      if (durable) await addOrg(replacement);
    });
    await run.a(SIGNED_IN);
    await run.b({ kind: 'cancelled' });
    expect(names()).toEqual(durable ? ['Replacement'] : []);
    const saved = JSON.parse(vault.get('orgs/list')!);
    expect(saved.map((o: { name: string }) => o.name)).toEqual(durable ? ['Replacement'] : []);
    if (durable) {
      expect(saved[0].teamDomain).toBe(replacement.teamDomain);
      expect(orgStore.get().orgs[0]?.teamDomain).toBe(replacement.teamDomain);
    }
  });

  it('A cancelled while B is out: B keeps the org, and B signed in keeps it and goes to Machines', async () => {
    const run = await twoSignInsOut();
    await run.a({ kind: 'cancelled' });
    expect(names()).toEqual(['New metadata']);
    await run.b(SIGNED_IN);
    expect(names()).toEqual(['New metadata']);
    expect(window.location.hash).toBe('#/machines');
  });

  it('a new org: A cancelled, then B cancelled: B (the owner) forgets the org', async () => {
    const run = await twoSignInsOut();
    await run.a({ kind: 'cancelled' });
    await run.b({ kind: 'cancelled' });
    expect(names()).toEqual([]);
  });

  it('an org already on the phone: A and B cancelled put back the original record, not either staging', async () => {
    await addOrg(OLD);
    const run = await twoSignInsOut();
    await run.a({ kind: 'cancelled' });
    expect(names()).toEqual(['New metadata']);
    await run.b({ kind: 'declined' });
    expect(names()).toEqual(['Old name']);
  });

  it('A signs in while B is out, then B is cancelled: A is durable now, so the org stays', async () => {
    const run = await twoSignInsOut();
    await run.a(SIGNED_IN);
    // A's late success neither navigates over B's screen nor settles B's ownership.
    expect(window.location.hash).toBe(`#/confirm?u=${encodeURIComponent(ORG)}`);
    await run.b({ kind: 'cancelled' });
    expect(names()).toEqual(['New metadata']);
  });

  it("B signs in first, then A's late cancellation changes nothing", async () => {
    const run = await twoSignInsOut();
    await run.b(SIGNED_IN);
    expect(window.location.hash).toBe('#/machines');
    await run.a({ kind: 'cancelled' });
    expect(names()).toEqual(['New metadata']);
    expect(window.location.hash).toBe('#/machines');
  });

  it("the org erased while both are out: neither late answer brings it back", async () => {
    await addOrg(OLD);
    const run = await twoSignInsOut();
    await act(async () => eraseEverything());
    await run.a({ kind: 'cancelled' });
    await run.b({ kind: 'cancelled' });
    expect(names()).toEqual([]);
  });
});

describe('control: one sign-in on its own', () => {
  it('cancelled, it forgets a new org it staged', async () => {
    vi.mocked(Session.signIn).mockReset().mockResolvedValueOnce({ kind: 'cancelled' } as never);
    window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
    renderShell(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await settle();
    expect(names()).toEqual([]);
  });

  it('signed in, it keeps the org and goes to Machines', async () => {
    vi.mocked(Session.signIn).mockReset().mockResolvedValueOnce(SIGNED_IN as never);
    window.location.hash = `#/confirm?u=${encodeURIComponent(ORG)}`;
    renderShell(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(window.location.hash).toBe('#/machines'));
    expect(names()).toEqual(['New metadata']);
  });
});

describe('the staging helpers', () => {
  it('a staging removed by a sign-out, then re-staged: the old one owns nothing and changes nothing', async () => {
    const a = await stageOrg({ id: ORG, name: 'A', teamDomain: null });
    await removeOrgLocal(ORG);
    expect(ownsStaging(ORG, a.token)).toBe(false);
    const b = await stageOrg({ id: ORG, name: 'B', teamDomain: null });
    expect(await unstageOrg(ORG, a.token)).toBe(false);
    expect(names()).toEqual(['B']);
    expect(ownsStaging(ORG, b.token)).toBe(true);
    settleStaging(ORG, b);
    expect(ownsStaging(ORG, b.token)).toBe(false);
  });

  it('removeOrgLocal without a claim of its own keeps its incarnation semantics', async () => {
    await addOrg(OLD);
    expect(await removeOrgLocal(ORG)).toBe(true);
    expect(names()).toEqual([]);
  });
});
