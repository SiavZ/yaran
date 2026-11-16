/**
 * Phone removed: an org answered `device_revoked`, so its sign-ins were deleted natively.
 *
 * - The org name came from the org; it renders as a chip, as React text.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/states/PhoneRemoved.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * ├── src/lib/route.ts
 * └── src/screens/Page.tsx
 * External: @lingui/react
 *
 * Used by:
 * src/screens/machines/states/PhoneRemoved.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { InlineCode } from '@yaran/ui-kit/inline-code';

import { navigate } from '../../../lib/route.ts';
import { Page } from '../../Page.tsx';

export function PhoneRemoved({ org }: { org: string }) {
  return (
    <Page title={<Trans>Phone removed</Trans>}>
      <p role="alert">
        <Trans>
          This phone was removed from <InlineCode>{org}</InlineCode> (by you or an admin), so its sign-ins were deleted.
          Add the org again to keep using it.
        </Trans>
      </p>
      <Button className="h-10" onClick={() => navigate({ name: 'welcome' })}>
        <Trans>Add an org</Trans>
      </Button>
    </Page>
  );
}
