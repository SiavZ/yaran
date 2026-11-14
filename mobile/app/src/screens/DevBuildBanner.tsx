/**
 * The development-build banner, shown on every screen of a build without a publisher domain.
 *
 * Such a build returns from sign-in on `yaranapp://auth/callback`, which any app on the phone
 * can register (D8, T36). The banner is persistent and cannot be dismissed.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/react, lucide-react
 *
 * Used by:
 * src/screens/DevBuildBanner.tsx
 * └── src/App.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';
import { TriangleAlertIcon } from 'lucide-react';

export function DevBuildBanner() {
  return (
    <div role="status" data-testid="dev-build-banner" className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/15 px-4 py-2 text-sm">
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <p>
        <Trans>Development build: sign-in replies use a link any app on this phone can claim. Use it only with test orgs.</Trans>
      </p>
    </div>
  );
}
