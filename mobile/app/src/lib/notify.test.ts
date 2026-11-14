/**
 * Tests for the toast raiser: severity windows from the shared policy and the busy guard.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/notify.test.ts
 * ├── @yaran/ui-kit:src/toast-policy.ts
 * └── src/lib/notify.ts
 * External: sonner, vitest
 *
 * Used by: entry point (vitest, via npm test in mobile/app)
 * <module-headers:end>
 */
import { statusToastDuration } from '@yaran/ui-kit/toast-policy';
import { toast } from 'sonner';
import { describe, expect, it, vi } from 'vitest';

import { notify, notifyBusy } from './notify.ts';

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), loading: vi.fn() } }));

describe('notify', () => {
  it('uses the shared severity windows', () => {
    notify('error', 'boom');
    expect(toast.error).toHaveBeenCalledWith('boom', { duration: statusToastDuration('error', null) });
    notify('success', 'ok', { id: 'k' });
    expect(toast.success).toHaveBeenCalledWith('ok', { id: 'k', duration: statusToastDuration('success', null) });
  });
  it('sticky waits for the user', () => {
    notify('warning', 'act', { sticky: true });
    expect(toast.warning).toHaveBeenCalledWith('act', { duration: Infinity });
  });
  it('replaces a stalled spinner with a warning on the same id', () => {
    vi.useFakeTimers();
    notifyBusy('rm', 'Removing…', 'Still waiting');
    vi.advanceTimersByTime(statusToastDuration('busy', null));
    expect(toast.warning).toHaveBeenCalledWith('Still waiting', expect.objectContaining({ id: 'rm' }));
    vi.useRealTimers();
  });
  it('a final on the id disarms the guard', () => {
    vi.useFakeTimers();
    notifyBusy('rm2', 'Removing…', 'Still waiting');
    notify('success', 'Removed', { id: 'rm2' });
    vi.advanceTimersByTime(statusToastDuration('busy', null));
    expect(toast.warning).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
