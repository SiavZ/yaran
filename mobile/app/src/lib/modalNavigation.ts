/** Give user-opened shared dialogs and menus a same-screen Back entry.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/modalNavigation.ts
 * └── @yaran/ui-kit:src/modalHistory.ts
 * External: none
 *
 * Used by:
 * src/lib/modalNavigation.ts
 * └── src/lib/route.ts
 * <module-headers:end>
 */
import { closeModals, onModalsChange, openModals, spendModals } from '@yaran/ui-kit/modalHistory';

type Entry = { id: number; hash: string; depth: number; session: string };
let navigateFromModal: ((hash: string, replace: boolean) => boolean) | null = null;

export function navigatePastModals(hash: string, replace: boolean): boolean {
  return navigateFromModal?.(hash, replace) ?? false;
}

export function installModalNavigation(): () => void {
  const session = crypto.randomUUID();
  let entries: Entry[] = [];
  let live = true;
  let scheduled = false;
  let traversing = false;
  let destination: { hash: string; replace: boolean } | null = null;
  const navigation = () => (window as Window & { navigation?: { currentEntry?: { index: number }; entries(): unknown[] } }).navigation;
  const index = () => navigation()?.currentEntry?.index;
  let lastIndex = index();
  const label = (): Entry | undefined => window.history.state?.yaranShellModal;
  const parked = (e: Entry) => label()?.session === e.session && label()?.id === e.id && window.location.hash === e.hash;
  const announce = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const write = (entry: Entry, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState']({ yaranShellModal: entry }, '', window.location.href);
    lastIndex = index();
  };
  const schedule = () => {
    if (scheduled || !live) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (live) reconcile(); });
  };
  const reconcile = () => {
    if (traversing) return;
    const wanted = openModals().filter((m) => !m.spent);
    let kept = 0;
    while (kept < entries.length && entries[kept]!.id === wanted[kept]?.id) kept++;
    const stale = entries.slice(kept);
    const fresh = wanted.slice(kept);
    entries = entries.slice(0, kept);
    if (stale.length && parked(stale[stale.length - 1]!)) {
      // A menu opening a dialog hands its entry to that dialog in the same commit.
      if (stale.length === 1 && fresh.length) {
        const entry = { ...stale[0]!, id: fresh.shift()!.id };
        write(entry, true);
        entries.push(entry);
      } else {
        traversing = true;
        window.history.go(-stale.length);
        return;
      }
    }
    // Automatic dialogs must not create entries Chrome can skip for lack of activation.
    if (navigator.userActivation?.isActive === false) {
      spendModals(fresh.map((m) => m.id));
      return;
    }
    for (const modal of fresh) {
      const entry = { id: modal.id, hash: window.location.hash, depth: entries.length + 1, session };
      write(entry);
      entries.push(entry);
    }
  };
  const traverse = () => {
    if (traversing) {
      traversing = false;
      const to = destination;
      destination = null;
      if (to && (to.replace || window.location.hash !== to.hash)) {
        window.history[to.replace ? 'replaceState' : 'pushState'](null, '', to.hash);
        announce();
      }
      lastIndex = index();
      schedule();
      return;
    }
    const here = label();
    const at = entries.findIndex((e) => e.session === here?.session && e.id === here?.id);
    if (here && at < 0) {
      // Back/Forward must pass a modal already closed, including after a reload.
      const now = index();
      const forward = now !== undefined && lastIndex !== undefined && now > lastIndex && now < navigation()!.entries().length - 1;
      window.history.go(forward ? 1 : -1);
      return;
    }
    const left = entries.slice(at + 1);
    entries = entries.slice(0, at + 1);
    closeModals(left.map((e) => e.id));
    lastIndex = index();
    schedule();
  };
  const move = (hash: string, replace: boolean) => {
    if (traversing) {
      destination = { hash, replace };
      window.history.replaceState(window.history.state, '', hash);
      announce();
      return true;
    }
    const old = entries;
    entries = [];
    closeModals(old.map((e) => e.id));
    if (!old.length || !parked(old[old.length - 1]!)) return false;
    // A pushed destination can reuse the modal's slot. A replace first returns to the page.
    const returnToPage = replace || hash === old[0]!.hash;
    if (returnToPage) { traversing = true; destination = { hash, replace }; }
    window.history.replaceState(returnToPage ? window.history.state : null, '', hash);
    announce();
    if (returnToPage) window.history.go(-old.length);
    return true;
  };
  const moved = () => {
    const left = entries.filter((e) => e.hash !== window.location.hash);
    if (!left.length) return;
    entries = entries.filter((e) => e.hash === window.location.hash);
    closeModals(left.map((e) => e.id));
  };
  navigateFromModal = move;
  onModalsChange(schedule);
  window.addEventListener('popstate', traverse);
  window.addEventListener('hashchange', moved);
  if (label()) { traversing = true; window.history.go(-label()!.depth); }
  schedule();
  return () => {
    live = false;
    if (navigateFromModal === move) navigateFromModal = null;
    spendModals(entries.map((e) => e.id));
    onModalsChange(() => undefined);
    window.removeEventListener('popstate', traverse);
    window.removeEventListener('hashchange', moved);
  };
}
