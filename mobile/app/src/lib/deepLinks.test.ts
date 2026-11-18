/**
 * Tests for incoming link routing, including the add-org confirm rule (T42).
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/deepLinks.test.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── cloud/protocol/fixtures/uri/add-machine.json
 * ├── cloud/protocol/fixtures/uri/agent-link.json
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/native/machineView.ts
 * ├── src/lib/orgStore.ts
 * └── src/lib/route.ts
 * External: @capacitor/app, sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import addMachine from '@yaran/protocol/fixtures/uri/add-machine.json' with { type: 'json' };
import agentLinks from '@yaran/protocol/fixtures/uri/agent-link.json' with { type: 'json' };
import { agentLinkUrl, type MachineSummary } from '@yaran/protocol';
import { AppLock } from '@yaran/secure-store';
import { App } from '@capacitor/app';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetBuildInfoForTests } from './buildInfo.ts';
import { installDeepLinks, openAgentLink, routeForAppUrl, type DeepLinks } from './deepLinks.ts';
import { addDirect, directStore } from './directStore.ts';
import { machinesStore, resetMachines } from './machinesStore.ts';
import { MachineView, Session } from './native/machineView.ts';
import { orgStore } from './orgStore.ts';
import { parseRoute } from './route.ts';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() } }));

describe('routeForAppUrl', () => {
  it('sends add-org to Confirm org, never straight in', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com')).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });
  it('refuses an add-org URL the host rules reject', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=https%3A%2F%2Fxn--80ak6aa92e.com')).toBe('refused');
  });
  it('refuses malformed and foreign links', () => {
    expect(routeForAppUrl('yaranapp://add-org?u=http%3A%2F%2Fcp.example.com')).toBe('refused');
    expect(routeForAppUrl('https://cp.example.com')).toBe('refused');
    expect(routeForAppUrl('yaranapp://nope')).toBe('refused');
  });
  it('maps home and settings, ignores reauth', () => {
    expect(routeForAppUrl('yaranapp://home')).toEqual({ name: 'machines' });
    expect(routeForAppUrl('yaranapp://settings')).toEqual({ name: 'settings' });
    expect(routeForAppUrl('yaranapp://reauth?host=m1.example.com')).toBeNull();
  });
});

let installed: DeepLinks | null = null;
afterEach(() => {
  installed?.remove();
  installed = null;
});

/** Installs the link wiring with `launch` as the launch URL; `send` fires a later `appUrlOpen`. */
async function install(launch?: string) {
  vi.mocked(App.getLaunchUrl).mockResolvedValueOnce(launch === undefined ? undefined : { url: launch });
  installed = await installDeepLinks();
  const calls = vi.mocked(App.addListener).mock.calls as unknown as [string, (e: { url: string }) => void][];
  const open = calls.filter((c) => c[0] === 'appUrlOpen').at(-1)![1];
  return { links: installed, send: (url: string) => open({ url }) };
}

describe('installDeepLinks', () => {
  it('a launch add-org link lands on Confirm org and claims the launch', async () => {
    const { links } = await install('yaranapp://add-org?u=https%3A%2F%2Fcp.example.com');
    expect(await links.settled()).toBe(true);
    expect(parseRoute(window.location.hash)).toEqual({ name: 'confirm', url: 'https://cp.example.com' });
  });
  it('a refused launch link warns and still claims the launch; reauth and no link do not', async () => {
    expect(await (await install('yaranapp://nope')).links.settled()).toBe(true);
    expect(toast.warning).toHaveBeenCalled();
    installed!.remove();
    expect(await (await install('yaranapp://reauth?host=m1.example.com')).links.settled()).toBe(false);
    installed!.remove();
    expect(await (await install()).links.settled()).toBe(false);
  });
});

describe('add-machine links', () => {
  it('only pre-fill Confirm machine, per the shared fixture', () => {
    for (const row of addMachine.parse) {
      const got = routeForAppUrl(row.uri);
      if (typeof row.expect === 'object' && row.expect !== null && 'host' in row.expect) {
        expect(got).toEqual({ name: 'confirm-machine', host: row.expect.host });
      } else {
        expect(got === 'refused' || got === null || (typeof got === 'object' && got.name !== 'confirm-machine')).toBe(true);
      }
    }
    expect(directStore.get().machines).toEqual([]);
  });
});

const DOMAIN = agentLinks.publisher_domain;
const ORG = { id: 'https://cp.example.com', name: 'Ada', teamDomain: null, addedAt: 'x' };
const MACHINE = '0b5f9a8e-6d0e-4f43-9a51-1d6f7d9b1c2a';
const listed = (hostname = 'box.example.com') =>
  machinesStore.set({ [ORG.id]: { state: 'ready', machines: [{ id: MACHINE, name: 'box', hostname } as MachineSummary], fetchedAt: 0 } });
const orgLink = (agentId: string, tabId?: string) =>
  agentLinkUrl(DOMAIN, { target: { kind: 'org', orgUrl: ORG.id, machineId: MACHINE }, agentId, ...(tabId === undefined ? {} : { tabId }) });

describe('verified agent links', () => {
  beforeEach(() => {
    resetMachines();
    orgStore.set({ loaded: true, orgs: [ORG] });
    resetBuildInfoForTests();
  });

  it('a development build refuses every link, even a valid one', async () => {
    listed();
    expect(await openAgentLink(orgLink('a1'), '')).toBe('dev_build');
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('refuses a link for another domain and every malformed fixture row', async () => {
    listed();
    expect(await openAgentLink(orgLink('a1'), 'other.example.org')).toBe('invalid');
    for (const row of agentLinks.parse.filter((r) => r.expect === 'uri_invalid')) {
      expect(await openAgentLink(row.url, DOMAIN)).toBe('invalid');
    }
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('opens a known org machine at the agent and tab, ids preserved through encoding', async () => {
    listed();
    expect(await openAgentLink(orgLink('a/b', 't#1'), DOMAIN)).toBe('opened');
    expect(MachineView.open).toHaveBeenCalledWith({ orgId: ORG.id, machineId: MACHINE, host: 'box.example.com', route: '#/agent/a%2Fb/tab/t%231' });
  });

  it('loads an org list that has not loaded yet, then opens from it', async () => {
    vi.mocked(Session.request).mockResolvedValueOnce({
      kind: 'ok',
      status: 200,
      body: { items: [{ id: MACHINE, name: 'box', hostname: 'box.example.com', url: 'https://box.example.com', status: 'online', status_checked_at: '2026-11-14T12:00:00Z', paired_at: '2026-11-14T12:00:00Z' }], next_cursor: null },
    });
    expect(await openAgentLink(orgLink('a1'), DOMAIN)).toBe('opened');
    expect(MachineView.open).toHaveBeenCalledWith(expect.objectContaining({ host: 'box.example.com', route: '#/agent/a1' }));
  });

  it('says the list could not load rather than calling the machine unknown', async () => {
    vi.mocked(Session.request).mockResolvedValueOnce({ kind: 'offline' });
    expect(await openAgentLink(orgLink('a1'), DOMAIN)).toBe('list_unavailable');
  });

  it('never adds an org or machine it does not know', async () => {
    orgStore.set({ loaded: true, orgs: [] });
    expect(await openAgentLink(orgLink('a1'), DOMAIN)).toBe('unknown_machine');
    orgStore.set({ loaded: true, orgs: [ORG] });
    machinesStore.set({ [ORG.id]: { state: 'ready', machines: [], fetchedAt: 0 } });
    vi.mocked(Session.request).mockResolvedValueOnce({ kind: 'ok', status: 200, body: { items: [], next_cursor: null } });
    expect(await openAgentLink(orgLink('a1'), DOMAIN)).toBe('unknown_machine');
    const direct = agentLinkUrl(DOMAIN, { target: { kind: 'direct', host: 'stranger.example.com' }, agentId: 'a1' });
    expect(await openAgentLink(direct, DOMAIN)).toBe('unknown_machine');
    expect(orgStore.get().orgs).toEqual([ORG]);
    expect(directStore.get().machines).toEqual([]);
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('opens a stored direct machine by its host with its own metadata', async () => {
    await addDirect({ host: 'laptop.tail1234.ts.net', instance: 'inst-1' });
    const link = agentLinkUrl(DOMAIN, { target: { kind: 'direct', host: 'laptop.tail1234.ts.net' }, agentId: 'a1', tabId: 't2' });
    expect(await openAgentLink(link, DOMAIN)).toBe('opened');
    expect(MachineView.open).toHaveBeenCalledWith({ kind: 'direct', host: 'laptop.tail1234.ts.net', instance: 'inst-1', route: '#/agent/a1/tab/t2' });
  });

  it('holds links while locked, says so once, and opens the last one once after unlock', async () => {
    listed();
    vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
    const locked = { enabled: true, allowPasscode: false, grace: '1min' as const, locked: true, biometry: 'available' as const };
    vi.mocked(AppLock.status).mockResolvedValueOnce(locked).mockResolvedValueOnce(locked);
    const { links, send } = await install(orgLink('a1'));
    send(orgLink('a2'));
    expect(await links.settled()).toBe(true);
    expect(MachineView.open).not.toHaveBeenCalled();
    expect(vi.mocked(toast.info).mock.calls.filter((c) => /Unlock yaran/.test(String(c[0])))).toHaveLength(1);
    links.release();
    links.release();
    await links.settled();
    expect(MachineView.open).toHaveBeenCalledTimes(1);
    expect(MachineView.open).toHaveBeenCalledWith(expect.objectContaining({ route: '#/agent/a2' }));
  });

  it('an unreadable lock state holds the link instead of opening it', async () => {
    listed();
    vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
    vi.mocked(AppLock.status).mockRejectedValueOnce(new Error('unavailable'));
    const { links } = await install(orgLink('a1'));
    expect(await links.settled()).toBe(true);
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('teardown drops a held link and stops a link mid-way', async () => {
    listed();
    vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
    vi.mocked(AppLock.status).mockResolvedValueOnce({ enabled: true, allowPasscode: false, grace: '1min', locked: true, biometry: 'available' });
    const { links, send } = await install(orgLink('a1'));
    await links.settled();
    links.remove();
    links.release();
    send(orgLink('a2'));
    await links.settled();
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  it('a dev build says so instead of opening', async () => {
    listed();
    vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'dev' });
    const { links } = await install(orgLink('a1'));
    await links.settled();
    expect(String(vi.mocked(toast.warning).mock.calls.at(-1)![0])).toMatch(/development build/);
    expect(MachineView.open).not.toHaveBeenCalled();
  });

  describe('a held link opens only once the app is really unlocked', () => {
    const LOCKED = { enabled: true, allowPasscode: false, grace: '1min' as const, locked: true, biometry: 'available' as const };
    const UNLOCKED = { ...LOCKED, locked: false };
    const holds = () => vi.mocked(toast.info).mock.calls.filter((c) => /Unlock yaran/.test(String(c[0]))).length;

    it('relocked while the release waits on the build: kept, then opened once on the next unlock', async () => {
      listed();
      vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
      const { links } = await install(orgLink('a1'));
      await links.settled();
      let build!: (v: { mode: 'https'; domain: string }) => void;
      vi.mocked(Session.callbackMode).mockReturnValueOnce(new Promise((r) => (build = r)));
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      links.release();
      await vi.waitFor(() => expect(Session.callbackMode).toHaveBeenCalled());
      vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
      build({ mode: 'https', domain: DOMAIN });
      await links.settled();
      expect(MachineView.open).not.toHaveBeenCalled();
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      links.release();
      links.release();
      await links.settled();
      expect(MachineView.open).toHaveBeenCalledTimes(1);
      expect(MachineView.open).toHaveBeenCalledWith(expect.objectContaining({ route: '#/agent/a1' }));
    });

    it('a vault_locked answer from native keeps the link for the next unlock, which opens it once', async () => {
      listed();
      vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      vi.mocked(MachineView.open).mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'vault_locked' }));
      const { links } = await install(orgLink('a1'));
      await links.settled();
      expect(holds()).toBe(1);
      expect(toast.error).not.toHaveBeenCalled();
      links.release();
      await links.settled();
      links.release();
      await links.settled();
      expect(MachineView.open).toHaveBeenCalledTimes(2);
      expect(vi.mocked(MachineView.open).mock.results[1]!.type).toBe('return');
    });

    it('a later link while one is held replaces it: the next unlock opens only the later one', async () => {
      listed();
      vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
      vi.mocked(AppLock.status).mockResolvedValue(LOCKED);
      const { links, send } = await install(orgLink('a1'));
      send(orgLink('a2'));
      await links.settled();
      vi.mocked(AppLock.status).mockResolvedValue(UNLOCKED);
      links.release();
      await links.settled();
      expect(vi.mocked(MachineView.open).mock.calls.map((c) => (c[0] as { route?: string }).route)).toEqual(['#/agent/a2']);
    });
  });

  describe('teardown while the last lock read before the open is out', () => {
    const UNLOCKED = { enabled: false, allowPasscode: false, grace: '1min' as const, locked: false, biometry: 'available' as const };
    it.each([
      ['an org machine', async () => (listed(), orgLink('a1'))],
      ['a direct machine', async () => (await addDirect({ host: 'laptop.tail1234.ts.net', instance: 'inst-1' }), agentLinkUrl(DOMAIN, { target: { kind: 'direct', host: 'laptop.tail1234.ts.net' }, agentId: 'a1' }))],
    ])('for %s, opens nothing once the link wiring is gone', async (_, arrange) => {
      const url = await arrange();
      vi.mocked(Session.callbackMode).mockResolvedValue({ mode: 'https', domain: DOMAIN });
      let last!: (v: typeof UNLOCKED) => void;
      // The first read (is the app locked?) answers; the one right before the open is held.
      vi.mocked(AppLock.status).mockResolvedValueOnce(UNLOCKED).mockReturnValueOnce(new Promise((r) => (last = r)));
      const { links } = await install(url);
      await vi.waitFor(() => expect(AppLock.status).toHaveBeenCalledTimes(2));
      links.remove();
      last(UNLOCKED);
      await links.settled();
      await new Promise((r) => setTimeout(r, 10));
      expect(MachineView.open).not.toHaveBeenCalled();
    });
  });
});
