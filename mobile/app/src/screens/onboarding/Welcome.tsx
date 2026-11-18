/**
 * Welcome: the first screen with no org added, offering the two ways to add one.
 *
 * - Scanning is the primary path; typing the address always exists, so a camera failure
 *   never blocks onboarding.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/onboarding/Welcome.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/route.ts
 * └── src/screens/Page.tsx
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/onboarding/Welcome.tsx
 * ├── src/App.tsx
 * └── src/screens/onboarding/onboarding.test.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { KeyboardIcon, QrCodeIcon } from 'lucide-react';

import { navigate } from '../../lib/route.ts';
import { Page } from '../Page.tsx';

export function Welcome() {
  return (
    <Page brand title={<Trans>Welcome</Trans>} className="welcome-page">
      <p className="max-w-sm text-xl leading-relaxed text-muted-foreground"><Trans>Your coding agents, within reach. Open the machines you work on from this phone.</Trans></p>
      <div className="mt-auto flex flex-col gap-3 pt-10">
        <p className="mb-1 text-sm font-medium"><Trans>Start by connecting your org.</Trans></p>
        <Button className="min-h-12" onClick={() => navigate({ name: 'scan' })}>
          <QrCodeIcon aria-hidden />
          <Trans>Scan QR code</Trans>
        </Button>
        <Button className="min-h-12" variant="outline" onClick={() => navigate({ name: 'enter-url' })}>
          <KeyboardIcon aria-hidden />
          <Trans>Type the org address</Trans>
        </Button>
        <aside className="mt-3 rounded-[1.75rem] bg-muted p-5 text-sm leading-relaxed text-muted-foreground">
          <p className="mb-2 font-medium text-foreground"><Trans>Need a QR code?</Trans></p>
          <p><Trans>On your computer, run <InlineCode>yaran cloud pair-phone</InlineCode>, or ask your admin for your org's code or address.</Trans></p>
        </aside>
      </div>
    </Page>
  );
}
