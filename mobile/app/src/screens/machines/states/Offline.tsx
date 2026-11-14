/**
 * Offline: no connection, with a retry.
 *
 * <module-headers:begin>
 * Uses:
 * src/screens/machines/states/Offline.tsx
 * └── @yaran/ui-kit:src/button.tsx
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/machines/states/Offline.tsx
 * ├── src/screens/machines/MachineList.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { Button } from '@yaran/ui-kit/button';
import { WifiOffIcon } from 'lucide-react';

export function Offline({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-border p-4">
      <p className="flex items-center gap-2">
        <WifiOffIcon aria-hidden className="size-4" />
        <Trans>No connection. Check your network and try again.</Trans>
      </p>
      <Button className="h-10" variant="outline" onClick={onRetry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}
