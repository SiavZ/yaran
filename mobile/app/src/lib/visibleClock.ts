/**
 * Visible-time interval: fires after a period of time the app was actually on screen.
 *
 * Modelled on the web UI's visible clock (not imported from it): a hidden or suspended
 * WebView accumulates nothing, so the Machines poll never fires a burst on resume and a
 * hidden app polls nothing.
 *
 * - The environment is injectable so tests drive time and visibility directly.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/lib/visibleClock.ts
 * ├── src/lib/visibleClock.test.ts
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */

export interface ClockEnv {
  now(): number;
  visible(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserEnv: ClockEnv = {
  now: () => performance.now(),
  visible: () => document.visibilityState === 'visible',
  setInterval: (fn, ms) => window.setInterval(fn, ms),
  clearInterval: (h) => window.clearInterval(h as number),
};

/** Calls `fn` every `periodMs` of visible time; returns the stop function. */
export function visibleInterval(fn: () => void, periodMs: number, env: ClockEnv = browserEnv, stepMs = 1000): () => void {
  let visibleMs = 0;
  let last = env.now();
  const handle = env.setInterval(() => {
    const now = env.now();
    // A step longer than a few ticks means the page was suspended: count one step at most.
    if (env.visible()) visibleMs += Math.min(now - last, stepMs * 2);
    last = now;
    if (visibleMs >= periodMs) {
      visibleMs = 0;
      fn();
    }
  }, stepMs);
  return () => env.clearInterval(handle);
}
