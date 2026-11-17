/**
 * Error state: one sentence for an API failure (envelope code → sentence), with a retry.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/states/ErrorState.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * └── src/lib/api.ts
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/machines/states/ErrorState.tsx
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { TriangleAlertIcon } from 'lucide-react';

import { failureMessage, type ApiFailure } from '../../../lib/api.ts';

export function ErrorState({ failure, onRetry }: { failure: ApiFailure; onRetry: () => void }) {
  const { i18n } = useLingui();
  return (
    <div role="alert" className="state-card">
      <TriangleAlertIcon aria-hidden className="size-5 text-destructive" />
      <p>{i18n._(failureMessage(failure))}</p>
      <Button className="min-h-12" variant="outline" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
