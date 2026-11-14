/**
 * English baseline for every push string the shell shows: row titles, details, actions and
 * toasts. Keys are stable; Phase 14's i18n catalog translates them.
 *
 * - `{name}` placeholders mark names the caller renders as chips, never quoted.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/push/pushStrings.ts
 * ├── src/push/NotificationSettingsSection.test.tsx
 * ├── src/push/NotificationSettingsSection.tsx
 * ├── src/push/notificationTap.ts
 * ├── src/push/pushPermission.test.ts
 * ├── src/push/pushPermission.ts
 * ├── src/push/pushWiring.ts
 * └── src/screens/settings/NotificationSettings.tsx
 * <module-headers:end>
 */
export const pushStrings = {
  "push.row.active": "Notifications are on",
  "push.row.needs_permission": "Notifications are not allowed for yaran on this phone",
  "push.row.no_distributor": "No UnifiedPush distributor installed",
  "push.row.no_distributor.detail": "Install a distributor app such as ntfy to receive notifications.",
  "push.row.push_unavailable": "Notifications cannot reach this phone",
  "push.row.registration_failed": "Turning on notifications failed",
  "push.row.refresh_pending": "Refreshing the notification registration",
  "push.row.delivery_failing": "The push service keeps failing; the organization keeps retrying",
  "push.row.org_disabled": "This organization has turned notifications off",
  "push.row.muted": "Muted on this phone",
  "push.row.muted.until": "Muted on this phone until {until}",
  "push.row.turned_off": "Notifications are off for this organization",
  "push.distributor.label": "Push distributor",
  "push.distributor.embedded": "Google Play services (built in)",
  "push.action.turn_on": "Turn on notifications",
  "push.action.allow": "Allow notifications",
  "push.action.open_settings": "Open system settings",
  "push.action.distributors": "Find a distributor",
  "push.action.retry": "Try again",
  "push.action.turn_off": "Turn off notifications for this organization…",
  "push.action.unmute": "Unmute",
  "push.action.mute_hour": "Mute for an hour",
  "push.action.mute_forever": "Mute until I unmute",
  "push.action.mute_machine": "Mute this machine",
  "push.confirm.turn_off.title": "Turn off notifications for {name}?",
  "push.confirm.turn_off.body": "This phone stops getting notifications from {name}. You stay signed in, and you can turn them back on here.",
  "push.rationale": "yaran tells you when an agent needs you or stops with an error. Allow notifications to get those alerts on this phone.",
  "push.toast.machine_muted": "Notifications from {name} are muted on this phone. Unmute it in Settings, Notifications.",
  "push.toast.mute_saved_offline": "Muted on this phone. The change reaches {name} when the phone is back online.",
  "push.toast.machine_unpaired": "That machine is no longer paired with this phone, so the notification cannot open it. Here are your machines.",
  "push.toast.turned_off": "Notifications from {name} are off on this phone.",
  "push.toast.revoked": "This phone was removed from {name}, so its notifications stopped.",
} as const;

export type PushStringKey = keyof typeof pushStrings;

export const DISTRIBUTORS_URL = "https://unifiedpush.org/users/distributors/";

/** The English text for `key` with its `{placeholders}` filled; a missing one keeps its braces. */
export function pushText(key: PushStringKey, vars: Record<string, string> = {}): string {
  return pushStrings[key].replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
