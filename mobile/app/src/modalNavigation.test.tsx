/** Back dismisses a shared modal before traversing the shell's hash routes.
 *
 * <module-headers:begin>
 * Uses:
 * src/modalNavigation.test.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── src/App.tsx
 * ├── src/lib/directStore.ts
 * ├── src/lib/orgStore.ts
 * ├── src/lib/route.ts
 * ├── src/lib/settingsStore.ts
 * └── src/test/render.tsx
 * External: @capacitor/app, @testing-library/react, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SecureStore } from '@yaran/secure-store';
import { App as CapacitorApp } from '@capacitor/app';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { App } from './App.tsx';
import { directStore } from './lib/directStore.ts';
import { orgStore } from './lib/orgStore.ts';
import { navigate } from './lib/route.ts';
import { DEFAULT_SETTINGS, settingsStore } from './lib/settingsStore.ts';
import { renderShell } from './test/render.tsx';

// Same-screen history model with stable Navigation API indices; real hash traversal is
// exercised separately below with jsdom's own history.
function installBrowserHistory() {
  let states: unknown[] = [null];
  let index = 0;
  const land = (at: number) => {
    if (at < 0 || at >= states.length || at === index) return;
    index = at;
    window.dispatchEvent(new PopStateEvent('popstate', { state: states[index] }));
  };
  const browser = {
    get state() { return states[index]; },
    get length() { return states.length; },
    get index() { return index; },
    pushState(state: unknown) { states = [...states.slice(0, index + 1), state]; index++; },
    replaceState(state: unknown) { states[index] = state; },
    back() { land(index - 1); },
    forward() { land(index + 1); },
    go(delta: number) { land(index + delta); },
  };
  Object.defineProperty(window, 'history', { configurable: true, value: browser });
  Object.defineProperty(window, 'navigation', { configurable: true, value: {
    get currentEntry() { return { index }; },
    entries() { return states.map((_, index) => ({ index })); },
  } });
  return browser;
}

const historyDescriptor = Object.getOwnPropertyDescriptor(window, 'history')!;
const globalHistoryDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'history')!;
const navigationDescriptor = Object.getOwnPropertyDescriptor(window, 'navigation');
const activationDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
beforeEach(() => {
  orgStore.set({ loaded: true, orgs: [] });
  settingsStore.set({ ...DEFAULT_SETTINGS });
  directStore.set({ loaded: true, machines: [{ id: 'd1', label: 'D', host: 'laptop.example.com', instance: 'i1', addedAt: 'x', routes: [{ kind: 'direct', host: 'laptop.example.com' }] }] });
  window.history.replaceState(null, '', '#/welcome');
});
afterEach(() => {
  Object.defineProperty(window, 'history', historyDescriptor);
  Object.defineProperty(globalThis, 'history', globalHistoryDescriptor);
  if (navigationDescriptor) Object.defineProperty(window, 'navigation', navigationDescriptor);
  else Reflect.deleteProperty(window, 'navigation');
  if (activationDescriptor) Object.defineProperty(navigator, 'userActivation', activationDescriptor);
  else Reflect.deleteProperty(navigator, 'userActivation');
});
async function back() {
  await act(async () => { window.history.back(); await new Promise((r) => setTimeout(r, 35)); });
}
it.each(['dialog', 'menu'] as const)('hash history: Back closes only the explicit %s, then goes back once', async (kind) => {
  renderShell(<App />);
  act(() => navigate({ name: kind === 'dialog' ? 'settings' : 'machines' }));
  await screen.findByRole('heading', { name: kind === 'dialog' ? 'Settings' : 'Machines' });
  const hash = window.location.hash;
  fireEvent.click(screen.getByRole('button', { name: kind === 'dialog' ? 'Erase everything on this phone…' : 'Actions for D' }));
  await screen.findByRole(kind);
  await back();
  expect(screen.queryByRole(kind)).toBeNull();
  expect(window.location.hash).toBe(hash);
  expect(SecureStore.eraseAll).not.toHaveBeenCalled();
  await back();
  expect(window.location.hash).toBe('#/welcome');
});
it('Cancel retires its entry before the next Back', async () => {
  renderShell(<App />);
  act(() => navigate({ name: 'settings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Erase everything on this phone…' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 35)); });
  await back();
  expect(window.location.hash).toBe('#/welcome');
  expect(SecureStore.eraseAll).not.toHaveBeenCalled();
});
it('a menu selection reuses its entry for the destination, leaving no empty modal stop', async () => {
  renderShell(<App />);
  act(() => navigate({ name: 'machines' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for D' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Ways to reach it…' }));
  await waitFor(() => expect(window.location.hash).toContain('#/machine-routes'));
  await back();
  expect(window.location.hash).toBe('#/machines');
  expect(screen.queryByRole('menu')).toBeNull();
  await back();
  expect(window.location.hash).toBe('#/welcome');
});
it('navigation to the same screen retires its open menu without duplicating that screen', async () => {
  renderShell(<App />);
  act(() => navigate({ name: 'machines' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for D' }));
  await screen.findByRole('menu');
  act(() => navigate({ name: 'machines' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 35)); });
  expect(screen.queryByRole('menu')).toBeNull();
  await back();
  expect(window.location.hash).toBe('#/welcome');
});
it.each(['same-screen-link', 'replace', 'queued-navigation'] as const)('Forward skips a modal retired by %s', async (mode) => {
  renderShell(<App />);
  act(() => navigate({ name: 'settings' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Erase everything on this phone…' }));
  await screen.findByRole('dialog');
  if (mode === 'same-screen-link') {
    const calls = () => vi.mocked(CapacitorApp.addListener).mock.calls as unknown as [string, (event: { url: string }) => void][];
    await waitFor(() => expect(calls().some(([name]) => name === 'appUrlOpen')).toBe(true));
    const receive = calls().find(([name]) => name === 'appUrlOpen')![1];
    await act(async () => receive({ url: 'yaranapp://settings' }));
  } else {
    act(() => {
      navigate({ name: mode === 'replace' ? 'orgs' : 'settings' }, { replace: mode === 'replace' });
      if (mode === 'queued-navigation') navigate({ name: 'orgs' }, { replace: true });
    });
  }
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(window.location.hash).toBe(mode === 'same-screen-link' ? '#/settings' : '#/orgs');
  window.history.replaceState({ testBase: true }, '', window.location.href);
  await act(async () => { window.history.forward(); await new Promise((r) => setTimeout(r, 50)); });
  expect(window.history.state).toEqual({ testBase: true });
  await back();
  expect(window.location.hash).toBe('#/welcome');
});
it.each(['dialog', 'menu'] as const)('Navigation API and user activation: %s has one Back entry', async (kind) => {
  window.location.hash = kind === 'dialog' ? '#/settings' : '#/machines';
  const browser = installBrowserHistory();
  window.history.replaceState(null, '', window.location.href);
  Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
  const view = renderShell(<App />);
  const hash = window.location.hash;
  fireEvent.click(screen.getByRole('button', { name: kind === 'dialog' ? 'Erase everything on this phone…' : 'Actions for D' }));
  await screen.findByRole(kind);
  await waitFor(() => expect(browser.length).toBe(2));
  await act(async () => browser.back());
  expect(screen.queryByRole(kind)).toBeNull();
  expect(window.location.hash).toBe(hash);
  await act(async () => browser.forward());
  expect(browser.index).toBe(0);
  expect(screen.queryByRole(kind)).toBeNull();
  view.unmount();
});
