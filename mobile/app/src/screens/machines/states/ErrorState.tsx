/**
 * Error state: one sentence for an API failure (envelope code → sentence), with a retry.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/states/ErrorState.tsx
 * ├── @yaran/ui-kit:src/button.tsx
 * └── src/lib/api.ts
 * External: @lingui/react
 *
 * Used by:
 * src/screens/machines/states/ErrorState.tsx
 * └── src/screens/machines/MachineList.tsx
 * <module-headers:end>
 */
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';

import { failureMessage, type ApiFailure } from '../../../lib/api.ts';

export function ErrorState({ failure, onRetry }: { failure: ApiFailure; onRetry: () => void }) {
  const { i18n } = useLingui();
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
      <p>{i18n._(failureMessage(failure))}</p>
      <Button className="h-10" variant="outline" onClick={onRetry}>
        <Trans>Try again</Trans>
      </Button>
    </div>
  );
}
