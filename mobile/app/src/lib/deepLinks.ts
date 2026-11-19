/**
 * Incoming links: `yaranapp://` links and verified `https://<publisher-domain>/open` agent links.
 *
 * Any app or web page can fire a link (T42), so nothing is ever added from one:
 * - `yaranapp://add-org?u=<org url>` lands on Confirm org and `yaranapp://add-machine?u=<url>`
 *   on Confirm machine, each with the address as a chip; `home` and `settings` navigate;
 *   `reauth` belongs to machine-view and is ignored; anything else is refused with a toast.
 * - A verified agent link (G6) is parsed against the publisher domain from this build's
 *   `Session.callbackMode()` (a development build has none and refuses every link), and opens
 *   only a machine already on this phone: an org machine by `orgUrl` plus machine id (its list
 *   refreshed first when it has not loaded), a direct machine by a stored direct host. The
 *   agent and tab ids become the route through `agentRoute`. While the app is locked, or its
 *   lock state cannot be read, the link is held (said once) and opens once after unlock.
 *
 * - The parse order is add-machine, agent link, then `parseAppUri`.
 * - Links are handled one at a time, in arrival order. `settled()` tells the launch whether a
 *   link claimed it, so reopening the last machine never runs ahead of (or over) a launch link.
 *   All of this state lives in one `installDeepLinks` call and dies with its teardown or with
 *   the caller's mount, whichever ends first.
 * - `file:` and `content:` URIs are what Android hands a share; they are not links, so they are
 *   ignored without a word and never claim the launch.
 * - The same launch URL delivered by both getLaunchUrl and appUrlOpen opens once.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/deepLinks.ts
 * ├── @yaran/machine-view:src/index.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/lib/buildInfo.ts
 * ├── src/lib/diagnostics.ts
 * ├── src/lib/directStore.ts
 * ├── src/lib/machinesStore.ts
 * ├── src/lib/notify.ts
 * ├── src/lib/openMachine.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/orgUrl.ts
 * └── src/lib/route.ts
 * External: @capacitor/app, @lingui/core
 *
 * Used by:
 * src/lib/deepLinks.ts
 * ├── src/lib/deepLinks.test.ts
 * ├── src/lib/heldLinks.test.ts
 * └── src/lib/lifecycle.ts
 * <module-headers:end>
 */
import { App } from '@capacitor/app';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { agentRoute } from '@yaran/machine-view';
import { parseAddMachineUri, parseAgentLink, parseAppUri } from '@yaran/protocol';
import { AppLock } from '@yaran/secure-store';

import { loadBuildInfo } from './buildInfo.ts';
import { log } from './diagnostics.ts';
import { findDirectByHost } from './directStore.ts';
import { machinesStore, refreshMachines } from './machinesStore.ts';
import { notify } from './notify.ts';
import { choseMachine, machineChoices, openDirect, openFailureMessage, openMachine, type OpenMachineResult } from './openMachine.ts';
import { findOrg } from './orgStore.ts';
import { normalizeTypedOrgUrl } from './orgUrl.ts';
import { navigate, type Route } from './route.ts';

/** Where a `yaranapp://` link leads, or null when the shell ignores it. Pure. */
export function routeForAppUrl(url: string): Route | 'refused' | null {
  const machine = parseAddMachineUri(url);
  if (machine.ok) return { name: 'confirm-machine', host: machine.host };
  const parsed = parseAppUri(url);
  if (!parsed.ok) return 'refused';
  switch (parsed.kind) {
    case 'add-org': {
      const org = normalizeTypedOrgUrl(parsed.orgUrl);
      return org.ok ? { name: 'confirm', url: org.value } : 'refused';
    }
    case 'home':
      return { name: 'machines' };
    case 'settings':
      return { name: 'settings' };
    case 'reauth':
      return null;
  }
}

export type AgentLinkOutcome = 'opened' | 'locked' | 'dev_build' | 'invalid' | 'unknown_machine' | 'list_unavailable' | Exclude<OpenMachineResult, { ok: true }>;

/**
 * Opens a verified agent link on a machine this phone already has; never adds one. `mayOpen` is
 * asked right before the native open, after every other await: `locked` means the app locked
 * meanwhile (or native refused with `vault_locked`), and the caller keeps the link.
 */
export async function openAgentLink(
  url: string,
  publisherDomain: string,
  alive: () => boolean = () => true,
  mayOpen: () => Promise<boolean> = async () => true,
): Promise<AgentLinkOutcome> {
  if (publisherDomain === '') return 'dev_build';
  const link = parseAgentLink(url, publisherDomain);
  if (!link.ok) return 'invalid';
  let route: string;
  try {
    route = agentRoute(link.agentId, link.tabId);
  } catch {
    return 'invalid';
  }
  let opened: OpenMachineResult;
  if (link.target.kind === 'org') {
    const { orgUrl, machineId } = link.target;
    if (!findOrg(orgUrl)) return 'unknown_machine';
    // The host comes from the org's authenticated list; load it when it is not there yet.
    const listed = () => machinesStore.get()[orgUrl]?.machines.some((m) => m.id === machineId) ?? false;
    if (!listed() && (await refreshMachines(orgUrl)) !== null && !listed()) return 'list_unavailable';
    if (!alive()) return 'invalid';
    if (!(await mayOpen())) return 'locked';
    // The last await before the native open: the shell may have gone meanwhile.
    if (!alive()) return 'invalid';
    opened = await openMachine(orgUrl, machineId, { route });
  } else {
    const record = findDirectByHost(link.target.host);
    if (!record) return 'unknown_machine';
    if (!(await mayOpen())) return 'locked';
    if (!alive()) return 'invalid';
    opened = await openDirect(record.id, { route });
  }
  if (opened.ok) return 'opened';
  if (opened.reason === 'native_refused' && opened.code === 'vault_locked') return 'locked';
  return opened.reason === 'unknown_machine' ? 'unknown_machine' : opened;
}

// An unreadable lock state counts as locked: a link never opens past the lock.
const unlocked = () => AppLock.status().then((s) => !s.locked, () => false);

/** Opens an agent link and says why when it cannot; resolves the outcome (`locked`: keep the link). */
async function handleAgentLink(url: string, alive: () => boolean, mayOpen: () => Promise<boolean> = unlocked): Promise<AgentLinkOutcome | null> {
  const build = await loadBuildInfo();
  if (!alive()) return null;
  const outcome = await openAgentLink(url, build.callback.mode === 'https' ? build.callback.domain : '', alive, mayOpen);
  if (!alive()) return null;
  switch (outcome) {
    case 'opened':
    case 'locked':
      return outcome;
    case 'dev_build':
      log('warn', 'refused an agent link: this build has no publisher domain');
      notify('warning', i18n._(msg`This development build can't open verified agent links. Install the app from an official channel to use them.`));
      return outcome;
    case 'invalid':
      log('warn', 'refused an https link that is not a valid agent link for this build');
      notify('warning', i18n._(msg`That link isn't a yaran link this app can open, so it was ignored.`));
      return outcome;
    case 'list_unavailable':
      log('warn', 'an agent link waited on a machines list that could not load');
      notify('error', i18n._(msg`The app couldn't load that org's machines to open the link. Check your connection and try again.`));
      return outcome;
    case 'unknown_machine':
      log('warn', 'refused an agent link for a machine this phone has not added');
      notify('warning', i18n._(msg`That link is for a machine this phone hasn't added.`));
      navigate({ name: 'machines' });
      return outcome;
    default:
      log('warn', `an agent link did not open: ${outcome.reason}`);
      notify('error', i18n._(openFailureMessage(outcome)));
      return outcome;
  }
}

/** A `yaranapp://` link: navigate, or refuse out loud. Resolves whether it claimed the launch. */
function handleAppLink(url: string): boolean {
  const target = routeForAppUrl(url);
  if (target === null) return false;
  if (target === 'refused') {
    log('warn', 'refused an incoming link that is not a valid yaranapp link');
    notify('warning', i18n._(msg`That link isn't a yaran link this app can open, so it was ignored.`));
    return true;
  }
  navigate(target);
  return true;
}

export interface DeepLinks {
  /** Resolves once every link so far is handled: whether any of them claimed the launch. */
  settled(): Promise<boolean>;
  /** Opens the link held while locked, once; a no-op when none is held. */
  release(): void;
  /** How many links have arrived so far: an automatic reopen yields to any that arrives after it began. */
  arrivals(): number;
  remove(): void;
}

/** How long after launch the same URL arriving through the other delivery is the launch's twin. */
export const STARTUP_TWIN_MS = 3000;
// URLs Android hands a share or a file view as; the share itself arrives through MachineView.
const NATIVE_FILE_URI = /^(?:file|content):/i;

/**
 * Wires `appUrlOpen` and the launch URL. `mounted` is the caller's own liveness, asked before
 * every step and every side effect, so a link resolving after the shell went away does nothing.
 */
export async function installDeepLinks(mounted: () => boolean = () => true): Promise<DeepLinks> {
  let removed = false;
  let claimed = false;
  // The link held for the lock, with the intake it came from (see `newest`).
  let held: { url: string; owner: number } | null = null;
  let arrived = 0;
  // Links taken in so far (file and content URIs are not links). Each attempt carries the number
  // it arrived as, a released one its original number: after any await only the newest may hold
  // or open, so an older attempt's late lock reply (or native `vault_locked`) cannot re-hold it.
  let newest = 0;
  // Unlocks seen (every `release`, held link or not): a lock read that an unlock overtook is
  // read again rather than trusted, so a link is never held after the unlock that would free it.
  let unlocks = 0;
  let chain: Promise<void> = Promise.resolve();
  const alive = () => !removed && mounted();
  const run = (job: () => Promise<boolean>) => {
    chain = chain
      .then(async () => {
        if (alive() && (await job())) claimed = true;
      })
      .catch((err: unknown) => log('warn', `an incoming link failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  const hold = (url: string, owner: number) => {
    if (held === null) notify('info', i18n._(msg`Unlock yaran to open that link.`));
    held = { url, owner };
  };
  // A new link and a released one take the same path: the lock is read now, and again right
  // before the native open; locked by then keeps the link for the next unlock.
  const current = async () => {
    for (;;) {
      const at = unlocks;
      // An unreadable state still counts as locked; a later relock is what the re-read sees.
      const open = await unlocked();
      if (open || at === unlocks) return open;
    }
  };
  /**
   * `owner` is the link's intake number; `claim` is what it took then (or at its release): the
   * machine-choice count after its own, and the address. After any await it may hold or open
   * only while it is the newest link AND nothing newer was chosen or navigated to since.
   */
  const attempt = async (url: string, owner: number, claim: () => boolean) => {
    const mine = () => alive() && owner === newest && claim();
    if (!(await current())) {
      if (mine()) hold(url, owner);
      return alive();
    }
    if (!mine()) return false;
    // The open itself is asked for only while this link is still the newest.
    const mayOpen = async () => (await current()) && mine();
    if ((await handleAgentLink(url, mine, mayOpen)) === 'locked' && mine()) hold(url, owner);
    return true;
  };
  // The choice count and the address as they are now; true while neither has moved since.
  const claimNow = () => {
    const choices = machineChoices();
    const from = window.location.hash;
    return () => machineChoices() === choices && window.location.hash === from;
  };
  const incoming = (url: string) => {
    // Counted at intake, before any await: a newer link outranks an automatic reopen at once, and
    // retires a link still held for the lock, so a later unlock never opens the older one after it.
    // A newer link that meets the lock itself becomes the held one.
    // Not a link at all: nothing to say, no held link retired, and the launch stays free for a waiting share.
    if (NATIVE_FILE_URI.test(url)) return run(async () => false);
    arrived++;
    held = null;
    const owner = ++newest;
    // An agent link is a machine chosen, like a tap on one: work for an older choice gives way.
    if (/^https:/i.test(url)) choseMachine();
    const claim = claimNow();
    run(async () => {
      if (!/^https:/i.test(url)) return owner === newest && claim() && handleAppLink(url);
      return attempt(url, owner, claim);
    });
  };

  // Capacitor may hand the launch URL to both getLaunchUrl and appUrlOpen, in either order.
  // One cross-delivery twin within STARTUP_TWIN_MS is dropped, once, for this install only.
  let launchPending = true;
  const early: { url: string; at: number }[] = [];
  let launched: { url: string; at: number } | null = null;
  const fresh = (at: number) => Date.now() - at < STARTUP_TWIN_MS;
  const launchOwner = newest;
  const launchClaim = claimNow();
  const handle = await App.addListener('appUrlOpen', ({ url }) => {
    if (launched?.url === url && fresh(launched.at)) {
      launched = null;
      return;
    }
    if (launchPending && early.length < 4) early.push({ url, at: Date.now() });
    incoming(url);
  });
  const links: DeepLinks = {
    settled: () => chain.then(() => claimed),
    release() {
      unlocks++;
      const was = held;
      held = null;
      if (was === null) return;
      arrived++;
      // Released now: the unlock is the moment it is asked for again, so its claim is taken now. It
      // pins newer machine choices only: each unlock path itself routes a waiting share right after
      // this release, an automatic move that must not cancel the link the person asked for.
      const choices = machineChoices();
      const claim = () => machineChoices() === choices;
      run(() => attempt(was.url, was.owner, claim));
    },
    arrivals: () => arrived,
    remove() {
      removed = true;
      held = null;
      void handle.remove();
    },
  };
  if (!alive()) {
    links.remove();
    return links;
  }
  const launch = await App.getLaunchUrl().catch(() => undefined);
  launchPending = false;
  const url = launch?.url;
  if (url && alive() && newest === launchOwner && launchClaim()) {
    const twin = early.findIndex((e) => e.url === url && fresh(e.at));
    if (twin < 0) {
      launched = { url, at: Date.now() };
      incoming(url);
    }
  }
  early.length = 0;
  return links;
}
