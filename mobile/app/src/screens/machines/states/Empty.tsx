/**
 * Empty states: no org added yet, or an org with no machines (with the `yaran cloud login` hint).
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/states/Empty.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * ├── @yaran/ui-kit:src/empty.tsx
 * ├── @yaran/ui-kit:src/inline-code.tsx
 * └── src/lib/route.ts
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/machines/states/Empty.tsx
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { Empty as EmptyFrame, EmptyDescription, EmptyHeader, EmptyTitle } from '@yaran/ui-kit/empty';
import { InlineCode } from '@yaran/ui-kit/inline-code';
import { MonitorIcon } from 'lucide-react';

import { navigate } from '../../../lib/route.ts';

export function NoOrgs() {
  return (
    <EmptyFrame>
      <EmptyHeader>
        <EmptyTitle>
          <Trans>No org added</Trans>
        </EmptyTitle>
        <EmptyDescription>
          <Trans>Add your org, or a machine reachable over HTTPS, to see your machines here.</Trans>
        </EmptyDescription>
      </EmptyHeader>
      <Button className="min-h-12" onClick={() => navigate({ name: 'welcome' })}>
        <Trans>Add an org</Trans>
      </Button>
    </EmptyFrame>
  );
}

export function NoMachines() {
  return (
    <div className="state-card">
      <MonitorIcon aria-hidden className="size-6 text-muted-foreground" />
      <h2 className="text-lg font-semibold"><Trans>Your machines will appear here</Trans></h2>
      <p className="text-muted-foreground"><Trans>No machines yet. On the computer you want to reach, run <InlineCode>yaran cloud login</InlineCode> and it appears here.</Trans></p>
    </div>
  );
}
