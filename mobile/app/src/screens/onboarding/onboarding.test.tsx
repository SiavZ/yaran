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
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/qr:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/screens/onboarding/ConfirmOrg.tsx
 * ├── src/screens/onboarding/EnterUrl.tsx
 * ├── src/screens/onboarding/ScanQr.tsx
 * ├── src/screens/onboarding/Welcome.tsx
 * └── src/test/render.tsx
 * External: @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { Meta } from '@yaran/protocol';
import { ScanError, startScan } from '@yaran/qr';
import { BuildInfo } from '@yaran/secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBuildInfoForTests } from '../../lib/buildInfo.ts';
import { Session } from '../../lib/native/machineView.ts';
import { orgStore } from '../../lib/orgStore.ts';
import { parseRoute } from '../../lib/route.ts';
import { renderShell } from '../../test/render.tsx';
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

beforeEach(() => {
  orgStore.set({ loaded: true, orgs: [] });
  resetBuildInfoForTests();
});

describe('Welcome', () => {
  it('offers scan and typed paths', () => {
    renderShell(<Welcome />);
    fireEvent.click(screen.getByRole('button', { name: /type the org address/i }));
    expect(route()).toEqual({ name: 'enter-url' });
  });
});

describe('EnterUrl', () => {
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
  it('sends a scanned add-org code to Confirm org', async () => {
    vi.mocked(startScan).mockReturnValue({ result: Promise.resolve('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com'), stop: vi.fn() });
    renderShell(<ScanQr />);
    await waitFor(() => expect(route()).toEqual({ name: 'confirm', url: 'https://cp.example.com' }));
  });
  it('explains a foreign code and a denied camera', async () => {
    vi.mocked(startScan).mockReturnValue({ result: Promise.resolve('https://example.com'), stop: vi.fn() });
    const { unmount } = renderShell(<ScanQr />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't a yaran org code/);
    unmount();
    vi.mocked(startScan).mockReturnValue({ result: Promise.reject(new ScanError('permission_denied')), stop: vi.fn() });
    renderShell(<ScanQr />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/camera permission is off/);
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

  it('adds the org after a successful sign-in and opens Machines', async () => {
    meta.mockResolvedValueOnce(ok(META));
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
