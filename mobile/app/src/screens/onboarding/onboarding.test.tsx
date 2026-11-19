/**
 * DOM tests for the onboarding screens with mocked plugins.
 *
 * Covers typed-URL refusals and the e2e prefill, the QR path, and Confirm org's failure
 * cases: offline, non-JSON, the Access redirect (missing public override, G8), a protocol
 * mismatch in each direction, `setup: open`, a sign-in cancel and `handoff_declined`, and
 * the happy path that adds the org only after sign-in.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/onboarding.test.tsx
 * ├── @yaran/machine-view:src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/qr:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/Welcome.tsx
 * ├── src/test/render.tsx
 * └── src/test/setup.ts
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { SignInOutcome } from '@yaran/machine-view';
import type { Meta } from '@yaran/protocol';
import { ScanError, startScan } from '@yaran/qr';
import { BuildInfo, SecureStore } from '@yaran/secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBuildInfoForTests } from '../../lib/buildInfo.ts';
import { Session } from '../../lib/native/machineView.ts';
import { choseMachine } from '../../lib/openMachine.ts';
import { addOrg, eraseEverything, orgStore, signOutOrg } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { renderShell } from '../../test/render.tsx';
import { vault } from '../../test/setup.ts';
import { ConfirmOrg } from './ConfirmOrg.tsx';
import { EnterUrl } from './EnterUrl.tsx';
import { ScanQr } from './ScanQr.tsx';
import { Welcome } from './Welcome.tsx';

vi.mock('@yaran/qr', async (orig) => ({ ...(await orig<typeof import('@yaran/qr')>()), startScan: vi.fn() }));

const META: Meta = {
  service: 'yaran-cloud',
  protocol: { min: 1, max: 1 },
  setup: 'closed',
  worker: { version: '1.0.0' },
  org: { name: 'Ada Org', url: 'https://cp.example.com' },
  access: { team_domain: 'ada.example.com' },
  capabilities: ['pairing.v1', 'handoff.v1'],
  push: { enabled: false, vapid_public_key: null },
};
const meta = vi.mocked(Session.meta);
const ok = (body: Meta) => ({ kind: 'ok' as const, status: 200, body });
const signIn = vi.mocked(Session.signIn);
const route = () => parseRoute(window.location.hash);
const listedIds = () => (JSON.parse(vault.get('orgs/list') ?? '[]') as { id: string }[]).map((o) => o.id);

/** The native handoff's own precondition (Android OrgList, iOS OrgList): the org must be in the vault's `orgs/list`. */
function nativeSignIn(after: SignInOutcome = { kind: 'signed_in', host: 'cp.example.com', email: 'ada@example.com', expiresAt: 1 }) {
  signIn.mockImplementationOnce(async ({ orgId }) => (listedIds().includes(orgId) ? after : { kind: 'refused', code: 'unknown_org' }));
}

beforeEach(() => {
  orgStore.set({ loaded: true, orgs: [] });
  resetBuildInfoForTests();
});

describe('Welcome', () => {
  it('offers scan and typed paths', () => {
    renderShell(<Welcome />);
    expect(screen.getByText('yaran cloud pair-phone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /type the org address/i }));
    expect(route()).toEqual({ name: 'enter-url' });
  });
});

describe('EnterUrl', () => {
  it('focuses the address field and has an explicit return to Welcome', () => {
    renderShell(<EnterUrl />);
    expect(document.activeElement).toBe(screen.getByLabelText('Org address'));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(route()).toEqual({ name: 'welcome' });
  });
  it('refuses http with a sentence and accepts a bare host', () => {
    renderShell(<EnterUrl />);
    const field = screen.getByLabelText('Org address');
    fireEvent.change(field, { target: { value: 'http://cp.example.com' } });
    fireEvent.submit(field.closest('form')!);
    expect(screen.getByRole('alert').textContent).toMatch(/must use https/);
    fireEvent.change(field, { target: { value: 'cp.example.com' } });
    fireEvent.submit(field.closest('form')!);
    expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });
  it('prefills the e2e control plane only in e2e builds', async () => {
    vi.mocked(BuildInfo.get).mockResolvedValueOnce({ flavor: 'foss', e2e: true, e2eControlPlaneUrl: 'cp.e2e.example.com' });
    renderShell(<EnterUrl />);
    await waitFor(() => expect((screen.getByLabelText('Org address') as HTMLInputElement).value).toBe('cp.e2e.example.com'));
  });
});

describe('ScanQr', () => {
  it('a delayed QR result yields to a newer machine choice without a hash change', async () => {
    let resolve!: (text: string) => void;
    vi.mocked(startScan).mockReturnValue({ result: new Promise((r) => { resolve = r; }), stop: vi.fn() });
    window.location.hash = '#/scan';
    renderShell(<ScanQr />);
    choseMachine();
    await act(async () => { resolve('yaranapp://add-machine?u=https%3A%2F%2Fbox.example.com'); });
    expect(window.location.hash).toBe('#/scan');
  });

  it.each([
    'yaranapp://add-machine?u=https%3A%2F%2Fbox.example.com',
    'yaranapp://add-org?u=https%3A%2F%2Fcp.example.com',
  ])('a delayed QR result yields to newer navigation: %s', async (payload) => {
    let resolve!: (text: string) => void;
    vi.mocked(startScan).mockReturnValue({ result: new Promise((r) => { resolve = r; }), stop: vi.fn() });
    window.location.hash = '#/scan';
    renderShell(<ScanQr />);
    window.location.hash = '#/settings';
    await act(async () => { resolve(payload); });
    expect(window.location.hash).toBe('#/settings');
  });

  it('a decoder completing after teardown cannot navigate', async () => {
    let resolve!: (text: string) => void;
    const stop = vi.fn();
    vi.mocked(startScan).mockReturnValue({ result: new Promise((r) => { resolve = r; }), stop });
    window.location.hash = '#/scan';
    const view = renderShell(<ScanQr />);
    view.unmount();
    await act(async () => { resolve('yaranapp://add-machine?u=https%3A%2F%2Fbox.example.com'); });
    expect(stop).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/scan');
  });

  it('lets a denied camera scan again after its permission changes', async () => {
    const stop = vi.fn();
    vi.mocked(startScan)
      .mockReturnValueOnce({ result: Promise.reject(new ScanError('permission_denied')), stop })
      .mockReturnValueOnce({ result: new Promise(() => {}), stop: vi.fn() });
    const calls = vi.mocked(startScan).mock.calls.length;
    renderShell(<ScanQr />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    await waitFor(() => expect(startScan).toHaveBeenCalledTimes(calls + 2));
    expect(stop).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Camera preview')).toBeTruthy();
  });
  it('sends a scanned add-org code to Confirm org', async () => {
    vi.mocked(startScan).mockReturnValue({ result: Promise.resolve('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com'), stop: vi.fn() });
    renderShell(<ScanQr />);
    await waitFor(() => expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' }));
  });
  it('explains a foreign code and a denied camera', async () => {
    vi.mocked(startScan).mockReturnValue({ result: Promise.resolve('https://example.com'), stop: vi.fn() });
    const { unmount } = renderShell(<ScanQr />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't a yaran org or machine code/);
    unmount();
    vi.mocked(startScan).mockReturnValue({ result: Promise.reject(new ScanError('permission_denied')), stop: vi.fn() });
    renderShell(<ScanQr />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/camera permission is off/);
    expect(screen.queryByLabelText('Camera preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Type the org address instead' }));
    expect(route()).toEqual({ name: 'enter-url' });
  });
});

describe('ConfirmOrg', () => {
  const cases: [string, () => void, RegExp][] = [
    ['offline', () => meta.mockResolvedValueOnce({ kind: 'offline' }), /No connection/],
    ['non-JSON', () => meta.mockResolvedValueOnce({ kind: 'refused', reason: 'not_json' }), /not like a yaran control plane/],
    ['Access redirect', () => meta.mockResolvedValueOnce({ kind: 'session_expired' }), /Access bypass/],
    ['app too old', () => meta.mockResolvedValueOnce(ok({ ...META, protocol: { min: 2, max: 3 } })), /newer than this app/],
    // Protocol 1 is the first, so a too-old control plane fails Meta validation (protocolCompat.test covers the verdict).
    ['an invalid Meta', () => meta.mockResolvedValueOnce(ok({ ...META, protocol: { min: 0, max: 0 } })), /not like a yaran control plane/],
    ['setup open', () => meta.mockResolvedValueOnce(ok({ ...META, setup: 'open' })), /hasn't finished setup/],
  ];
  for (const [name, arrange, text] of cases) {
    it(`stops on ${name} without offering sign-in`, async () => {
      arrange();
      renderShell(<ConfirmOrg url="https://cp.example.com" />);
      expect((await screen.findByRole('alert')).textContent).toMatch(text);
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    });
  }

  it('shows the URL as a chip, the org, the edge disclosure and the consent hint', async () => {
    meta.mockResolvedValueOnce(ok(META));
    const { container } = renderShell(<ConfirmOrg url="https://cp.example.com" />);
    await screen.findByRole('button', { name: 'Sign in' });
    expect(container.querySelector('[data-slot="inline-code"]')?.textContent).toBe('https://cp.example.com');
    expect(screen.getByText('Ada Org')).toBeTruthy();
    expect(screen.getByText(/decrypts it at its edge/)).toBeTruthy();
    expect(screen.getByText(/Sign this device in to cp.example.com\?/)).toBeTruthy();
  });

  it.each([
    [{ kind: 'cancelled' } as const, /Sign-in was cancelled/],
    [{ kind: 'declined' } as const, /You chose Cancel on the sign-in page/],
  ])('explains %o and does not add the org', async (outcome, text) => {
    meta.mockResolvedValueOnce(ok(META));
    signIn.mockResolvedValueOnce(outcome);
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(orgStore.get().orgs).toEqual([]);
  });

  it('lists a new org where the native handoff looks before signing in, and removes it again on failure', async () => {
    meta.mockResolvedValueOnce(ok(META));
    nativeSignIn({ kind: 'cancelled' });
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Sign-in was cancelled/);
    expect(listedIds()).toEqual([]);
    expect(orgStore.get().orgs).toEqual([]);

    nativeSignIn();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(route()).toEqual({ name: 'machines' }));
    expect(listedIds()).toEqual(['https://cp.example.com']);
  });

  it('puts an already-added org back as it was when signing in again fails', async () => {
    const before = { id: 'https://cp.example.com', name: 'Old name', teamDomain: null, addedAt: '2026-01-01T00:00:00.000Z' };
    vault.set('orgs/list', JSON.stringify([before]));
    orgStore.set({ loaded: true, orgs: [before] });
    meta.mockResolvedValueOnce(ok(META));
    nativeSignIn({ kind: 'declined' });
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    await waitFor(() => expect(orgStore.get().orgs).toEqual([before]));
    expect(JSON.parse(vault.get('orgs/list')!)).toEqual([before]);
  });

  it('names a vault or native refusal by its code instead of calling it a lock or offline', async () => {
    const { SecureStore } = await import('@yaran/secure-store');
    meta.mockResolvedValueOnce(ok(META));
    vi.mocked(SecureStore.set).mockRejectedValueOnce(Object.assign(new Error('keystore'), { code: 'key_invalidated' }));
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const said = (await screen.findByRole('alert')).textContent!;
    expect(said).toContain('key_invalidated');
    expect(said).not.toMatch(/Unlock/);
    expect(signIn).not.toHaveBeenCalled();

    signIn.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'native_error' }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('native_error'));
    expect(screen.getByRole('alert').textContent).not.toMatch(/No connection/);
    expect(orgStore.get().orgs).toEqual([]);
  });

  it('says secure storage failed, not that the app is locked', async () => {
    meta.mockResolvedValueOnce(ok(META));
    signIn.mockResolvedValueOnce({ kind: 'secure_storage_failed' });
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    const said = (await screen.findByRole('alert')).textContent!;
    expect(said).toMatch(/secure storage/);
    expect(said).not.toMatch(/Unlock/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('adds the org after a successful sign-in and opens Machines', async () => {
    meta.mockResolvedValueOnce(ok(META));
    nativeSignIn();
    renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(route()).toEqual({ name: 'machines' }));
    expect(signIn).toHaveBeenCalledWith({ orgId: 'https://cp.example.com', target: 'control-plane' });
    expect(orgStore.get().orgs).toMatchObject([{ id: 'https://cp.example.com', name: 'Ada Org', teamDomain: 'ada.example.com' }]);
  });

  it('refuses a URL the host rules reject without contacting it', () => {
    renderShell(<ConfirmOrg url="https://192.168.1.1" />);
    expect(screen.getByRole('alert').textContent).toMatch(/isn't valid/);
    expect(meta).not.toHaveBeenCalled();
  });
});

describe('ConfirmOrg after Erase everything, and after the screen is gone', () => {
  const OLD = { id: 'https://cp.example.com', name: 'Old name', teamDomain: null, addedAt: '2026-01-01T00:00:00.000Z' };
  function pending() {
    let finish!: (o: SignInOutcome) => void;
    signIn.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    return (o: SignInOutcome) => finish(o);
  }
  async function startOn(existing: boolean) {
    if (existing) {
      vault.set('orgs/list', JSON.stringify([OLD]));
      orgStore.set({ loaded: true, orgs: [OLD] });
    }
    meta.mockResolvedValueOnce(ok(META));
    window.location.hash = '#/confirm?u=https%3A%2F%2Fcp.example.com';
    const view = renderShell(<ConfirmOrg url="https://cp.example.com" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(signIn).toHaveBeenCalled());
    return view;
  }

  it.each([
    ['cancelled', { kind: 'cancelled' } as SignInOutcome],
    ['an error', { kind: 'offline' } as SignInOutcome],
    ['signed in', { kind: 'signed_in', host: 'cp.example.com', email: 'ada@example.com', expiresAt: 1 } as SignInOutcome],
  ])('a sign-in that ends %s after an erase brings nothing back and goes nowhere', async (_, outcome) => {
    const finish = pending();
    await startOn(true);
    await eraseEverything();
    finish(outcome);
    await new Promise((r) => setTimeout(r, 20));
    expect(orgStore.get().orgs).toEqual([]);
    expect(vault.get('orgs/list')).toBeUndefined();
    expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });

  it('after the screen is gone: a failed sign-in still takes its staged org back out, and a success navigates nowhere', async () => {
    const finish = pending();
    const view = await startOn(false);
    view.unmount();
    finish({ kind: 'cancelled' });
    await waitFor(() => expect(listedIds()).toEqual([]));
    expect(orgStore.get().orgs).toEqual([]);

    const success = pending();
    const again = await startOn(false);
    again.unmount();
    success({ kind: 'signed_in', host: 'cp.example.com', email: 'ada@example.com', expiresAt: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(listedIds()).toEqual(['https://cp.example.com']);
    expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });

  describe('signing out of the org while its re-sign-in is pending', () => {
    const NEW = { id: 'https://cp.example.com', name: 'New name', teamDomain: 'new.cloudflareaccess.com' };
    const onDisk = () => JSON.parse(vault.get('orgs/list') ?? '[]') as { id: string; name: string; teamDomain: string | null }[];

    it.each([
      ['cancelled', { kind: 'cancelled' } as SignInOutcome],
      ['failing', { kind: 'offline' } as SignInOutcome],
    ])('a sign-in that ends %s does not put the signed-out org back', async (_, outcome) => {
      const finish = pending();
      await startOn(true);
      await signOutOrg(OLD.id);
      finish(outcome);
      await new Promise((r) => setTimeout(r, 20));
      expect(orgStore.get().orgs).toEqual([]);
      expect(onDisk()).toEqual([]);
      expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
    });

    it('nor overwrite the org added again since with the old name and team', async () => {
      const finish = pending();
      await startOn(true);
      await signOutOrg(OLD.id);
      await addOrg(NEW);
      finish({ kind: 'cancelled' });
      await new Promise((r) => setTimeout(r, 20));
      expect(orgStore.get().orgs).toMatchObject([NEW]);
      expect(onDisk()).toMatchObject([NEW]);
    });

    it('nor restore when the sign-out removal is still queued as the result arrives', async () => {
      const finish = pending();
      await startOn(true);
      // Hold the sign-out's removal write in the org queue, then answer the sign-in.
      const real = vi.mocked(SecureStore.set).getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      vi.mocked(SecureStore.set).mockImplementationOnce(async (o) => (await gate, real(o)));
      const signingOut = signOutOrg(OLD.id);
      await vi.waitFor(() => expect(SecureStore.set).toHaveBeenCalled());
      finish({ kind: 'cancelled' });
      await new Promise((r) => setTimeout(r, 10));
      release();
      await signingOut;
      await new Promise((r) => setTimeout(r, 20));
      expect(orgStore.get().orgs).toEqual([]);
      expect(onDisk()).toEqual([]);
    });

    it('a failed re-sign-in that still owns its staging puts the previous org back', async () => {
      const finish = pending();
      await startOn(true);
      finish({ kind: 'cancelled' });
      await waitFor(() => expect(orgStore.get().orgs).toEqual([OLD]));
      expect(onDisk()).toEqual([OLD]);
    });
  });
});
