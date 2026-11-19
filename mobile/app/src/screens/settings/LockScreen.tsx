/**
 * Lock screen: shown while the app lock is engaged; Unlock runs the native biometric prompt.
 *
 * The native side already hides machine-view and covers app-switcher snapshots; this screen
 * replaces the shell's content until unlock succeeds. An invalidated key (biometrics changed)
 * means the native core wiped the locked class, so the sessions are gone and it says so.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/settings/LockScreen.tsx
 * ├── @yaran/secure-store:src/index.ts
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/openMachine.ts
 * └── src/screens/Page.tsx
 * External: @lingui/react, lucide-react, react
 *
 * Used by:
 * src/screens/settings/LockScreen.tsx
 * ├── src/App.tsx
 * └── src/screens/settings/settings.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { AppLock } from '@yaran/secure-store';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { LockIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { rejectionCode } from '../../lib/openMachine.ts';
import { Page } from '../Page.tsx';

export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [note, setNote] = useState<'cancelled' | 'invalidated' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function unlock() {
    setFailure(null);
    setNote(null);
    try {
      const { outcome } = await AppLock.unlock();
      if (!mounted.current) return;
      if (outcome === 'cancelled') return setNote('cancelled');
      if (outcome === 'invalidated') setNote('invalidated');
      else onUnlocked();
    } catch (err) { if (mounted.current) setFailure(rejectionCode(err)); }
  }

  if (note === 'invalidated') {
    return (
      <Page title={<Trans>Sign-ins removed</Trans>}>
        <p role="alert">
          <Trans>
            The biometrics on this phone changed, so yaran deleted its sign-ins to keep them safe. Your orgs are still listed; sign
            in to each one again.
          </Trans>
        </p>
        <Button className="min-h-12" onClick={onUnlocked}>
          <Trans>Continue</Trans>
        </Button>
      </Page>
    );
  }
  const code = <InlineCode>{failure}</InlineCode>;
  return (
    <Page title={<Trans>yaran is locked</Trans>}>
      {/* Centred on the sheet: centring the page itself would shrink the sheet to its content. */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
        <LockIcon aria-hidden className="size-10 self-center text-muted-foreground" />
        {failure !== null && <p role="alert"><Trans>yaran couldn't unlock ({code}). Try again.</Trans></p>}
        {note === 'cancelled' && (
          <p role="status" className="text-sm text-muted-foreground">
            <Trans>Unlock was cancelled.</Trans>
          </p>
        )}
        <Button className="min-h-12" autoFocus onClick={() => void unlock()}>
          <Trans>Unlock</Trans>
        </Button>
      </div>
    </Page>
  );
}
