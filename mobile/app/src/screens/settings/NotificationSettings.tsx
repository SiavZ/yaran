/**
 * Notifications section of Settings: the mount point for Phase 16's push rows.
 *
 * Phase 16 owns push (registration, distributors, permission UX, mutes) and ships
 * `NotificationSettingsSection` from `@yaran/push`; it replaces the body below with that
 * component and wires its effects. Until then the section states that this build has no push.
 *
 * - Seam: this file is the only place Settings learns about push.
 *
 * <module-headers:begin>
 * Uses: none
 * External: @lingui/react
 *
 * Used by:
 * src/screens/settings/NotificationSettings.tsx
 * └── src/screens/settings/Settings.tsx
 * <module-headers:end>
 */
import { Trans } from '@lingui/react/macro';

export function NotificationSettings() {
  return (
    <p className="text-sm text-muted-foreground">
      <Trans>This build doesn't include notifications yet.</Trans>
    </p>
  );
}
