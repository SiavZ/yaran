/**
 * The one place the shell raises a toast (a boundary test keeps it that way).
 *
 * sonner is the countdown mechanism; the timing policy is the web's, shared through
 * `@yaran/ui-kit/toast-policy`, so both surfaces grade windows by severity the same way.
 * A busy toast is replaced by its own final on the same id, or by a warning when nothing
 * arrives before the busy ceiling: a spinner never just vanishes.
 *
 * - Messages are plain strings or React nodes; names inside them are chips built by callers.
 *
 * <module-headers:begin>
 * Uses:
 * src/lib/notify.ts
 * └── @yaran/ui-kit:src/toast-policy.ts
 * External: react, sonner
 *
 * Used by:
 * src/lib/notify.ts
 * ├── src/lib/deepLinks.ts
 * ├── src/lib/notify.test.ts
 * ├── src/push/pushWiring.ts
 * ├── src/screens/machines/RemoveMachineDialog.tsx
 * ├── src/screens/orgs/SignOutOrgDialog.tsx
 * ├── src/screens/settings/Diagnostics.tsx
 * ├── src/screens/settings/EraseDialog.tsx
 * └── src/screens/settings/SecuritySettings.tsx
 * <module-headers:end>
 */
import { statusToastDuration } from '@yaran/ui-kit/toast-policy';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

export type Tone = 'info' | 'success' | 'warning' | 'error';

const guards = new Map<string, ReturnType<typeof setTimeout>>();

function disarm(id: string | undefined): void {
  if (id === undefined) return;
  clearTimeout(guards.get(id));
  guards.delete(id);
}

/** Raises a final toast; `sticky` waits for the user (reserved for must-act cases). */
export function notify(tone: Tone, message: ReactNode, options: { id?: string; sticky?: boolean } = {}): void {
  disarm(options.id);
  const duration = options.sticky ? Infinity : statusToastDuration(tone, null);
  const opts = options.id === undefined ? { duration } : { id: options.id, duration };
  switch (tone) {
    case 'info':
      toast.info(message, opts);
      return;
    case 'success':
      toast.success(message, opts);
      return;
    case 'warning':
      toast.warning(message, opts);
      return;
    case 'error':
      toast.error(message, opts);
      return;
  }
}

/** Raises a spinner on `id`; its final must reuse the same id. */
export function notifyBusy(id: string, message: ReactNode, stalled: ReactNode): void {
  disarm(id);
  toast.loading(message, { id, duration: Infinity });
  guards.set(
    id,
    setTimeout(() => notify('warning', stalled, { id }), statusToastDuration('busy', null)),
  );
}
