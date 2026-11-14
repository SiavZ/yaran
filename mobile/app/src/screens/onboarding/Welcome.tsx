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
    <Page title={<Trans>Welcome to yaran</Trans>}>
      <p className="text-muted-foreground">
        <Trans>
          Open the coding agents running on your machines from this phone. To start, add your org: scan the QR code
          your admin or <InlineCode>yaran cloud login</InlineCode> shows, or type its address.
        </Trans>
      </p>
      <div className="flex flex-col gap-3">
        <Button className="h-10" onClick={() => navigate({ name: 'scan' })}>
          <QrCodeIcon aria-hidden />
          <Trans>Scan QR code</Trans>
        </Button>
        <Button className="h-10" variant="outline" onClick={() => navigate({ name: 'enter-url' })}>
          <KeyboardIcon aria-hidden />
          <Trans>Type the org address</Trans>
        </Button>
      </div>
    </Page>
  );
}
