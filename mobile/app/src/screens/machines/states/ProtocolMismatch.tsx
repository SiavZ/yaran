/**
 * Protocol mismatch: names who has to update, the app or the org's control plane, and how.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/react
 *
 * Used by:
 * src/screens/machines/states/ProtocolMismatch.tsx
 * └── src/screens/onboarding/ConfirmOrg.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';

export function ProtocolMismatch({ update }: { update: 'app' | 'control_plane' }) {
  return (
    <div role="alert" className="rounded-lg border border-border p-4">
      {update === 'app' ? (
        <p>
          <Trans>This org's control plane is newer than this app. Update yaran from your app store, then try again.</Trans>
        </p>
      ) : (
        <p>
          <Trans>This org's control plane is too old for this app. Ask your admin to update the control plane, then try again.</Trans>
        </p>
      )}
    </div>
  );
}
