/**
 * Setup incomplete: `/v1/meta` says `setup: open`, so no sign-in is offered.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/react
 *
 * Used by:
 * src/screens/machines/states/SetupIncomplete.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';

export function SetupIncomplete() {
  return (
    <p role="alert" className="rounded-lg border border-border p-4">
      <Trans>This control plane hasn't finished setup yet. Ask your admin to finish the setup page, then try again.</Trans>
    </p>
  );
}
