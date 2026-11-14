/**
 * Tests for the visible-time interval.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/visibleClock.test.ts
 * └── src/lib/visibleClock.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { describe, expect, it, vi } from 'vitest';

import { visibleInterval, type ClockEnv } from './visibleClock.ts';

function fakeEnv() {
  let t = 0;
  let visible = true;
  let tick: () => void = () => {};
  const env: ClockEnv = {
    now: () => t,
    visible: () => visible,
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = () => {}),
  };
  return {
    env,
    advance(ms: number) {
      t += ms;
      tick();
    },
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

describe('visibleInterval', () => {
  it('fires after the period of visible time', () => {
    const f = fakeEnv();
    const fn = vi.fn();
    visibleInterval(fn, 3000, f.env);
    f.advance(1000);
    f.advance(1000);
    expect(fn).not.toHaveBeenCalled();
    f.advance(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('accumulates nothing while hidden', () => {
    const f = fakeEnv();
    const fn = vi.fn();
    visibleInterval(fn, 2000, f.env);
    f.hide();
    for (let i = 0; i < 10; i++) f.advance(1000);
    expect(fn).not.toHaveBeenCalled();
    f.show();
    f.advance(1000);
    f.advance(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('counts a suspension as one step, not hours', () => {
    const f = fakeEnv();
    const fn = vi.fn();
    visibleInterval(fn, 30_000, f.env);
    f.advance(3_600_000);
    expect(fn).not.toHaveBeenCalled();
  });
  it('stops', () => {
    const f = fakeEnv();
    const fn = vi.fn();
    const stop = visibleInterval(fn, 1000, f.env);
    stop();
    f.advance(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});
