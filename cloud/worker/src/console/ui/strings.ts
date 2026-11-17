/**
 * English baseline for every console, setup and admin string, in the house voice.
 *
 * Verbose and actionable: a message says what happened and what to do next. Sentences
 * that carry a name are built at the call site as prose plus a `Chip`, never by quoting
 * the name inside a string here.
 *
 * - Data only.
 *
 * <module-headers:begin>
 * Uses:
 * src/console/ui/strings.ts
 * └── @yaran/protocol:src/index.ts
 * External: none
 *
 * Used by:
 * src/console/ui/strings.ts
 * ├── src/console/admin-pages.tsx
 * ├── src/console/routes.ts
 * ├── src/console/ui/components.tsx
 * ├── src/console/ui/confirm.tsx
 * ├── src/console/ui/shell.tsx
 * ├── src/console/user-pages.tsx
 * ├── src/setup/pages.tsx
 * └── src/ui/kit.ts
 * <module-headers:end>
 */
import type { AdminUser, Flavor, MachineStatus, Platform, PushChannel, PushState } from "@yaran/protocol";

/** The tone of a `Status` dot; the word beside it always carries the meaning. */
export type StatusTone = "ok" | "warn" | "error" | "info" | "off";

export const S = {
  skipLink: "Skip to the main content",
  copy: "Copy",
  cancel: "Cancel",
  back: "Back",
  never: "never",
  signedInAs: "Signed in as",
  actions: "Actions",
  errorCode: "Error code:",
  alreadyRemoved: "was already removed, so there is nothing left to do.",
  tone: { info: "Note:", warn: "Warning:", error: "Error:", success: "Done:" },
  nav: {
    label: "Console",
    machines: "My machines",
    phones: "My phones",
    connect: "Connect",
    users: "Users",
    adminMachines: "Machines",
    devices: "Phones",
    audit: "Audit log",
    settings: "Settings",
    health: "Health",
    updates: "Updates",
    admin: "Admin",
    workspace: "My workspace",
    adminContext: "Admin",
  },
  machineStatus: {
    online: ["Online", "ok"],
    degraded: ["Degraded", "warn"],
    offline: ["Offline", "off"],
    never_connected: ["Never connected", "off"],
    provisioning: ["Setting up", "info"],
    tearing_down: ["Being removed", "error"],
    unknown: ["Status unknown", "off"],
  } satisfies Record<MachineStatus, readonly [string, StatusTone]>,
  platform: { android: "Android", ios: "iOS" } satisfies Record<Platform, string>,
  flavor: { foss: "F-Droid build", play: "Google Play build", appstore: "App Store build", dev: "development build" } satisfies Record<Flavor, string>,
  pushChannel: { unifiedpush: "UnifiedPush", fcm_embedded: "Firebase", apns_relay: "Apple push relay", fcm_relay: "Firebase relay" } satisfies Record<PushChannel, string>,
  pushState: {
    active: "Push working",
    gone: "Push stopped: the subscription expired",
    auth_failed: "Push stopped: the phone must register again",
    failing: "Push is failing",
    none: "Push off",
  } satisfies Record<PushState, string>,
  /** What brings a stopped push back (website/docs/cloud-troubleshooting.md: the app registers again when opened). */
  pushRecovery: "Opening the yaran app on the phone once registers it again.",
  pushTone: { active: "ok", gone: "warn", auth_failed: "warn", failing: "error", none: "off" } satisfies Record<PushState, StatusTone>,
  role: { admin: "Administrator", user: "Member" } satisfies Record<AdminUser["role"], string>,
  users: {
    active: "Active",
    disabled: "Disabled",
    demote: "Remove admin rights…",
    demoteTitle: "Remove admin rights",
    demoteLead: "Remove admin rights from",
  },
  machines: {
    empty: "You have no paired machines yet. Pairing takes one command in the machine's terminal.",
    emptyAction: "Pair a machine",
    renameHint: "To rename a machine, unpair it and pair it again: the name is part of its hostname, Access application and DNS record.",
    open: "Open",
    unpair: "Unpair…",
    unpairLead: "Unpair the machine",
    unpairConsequence: "Its tunnel, DNS record and Access application are deleted. The machine stops being reachable from your phones until you pair it again.",
    unpaired: "Unpairing started for the machine",
    unpairedTail: "Its Cloudflare objects are being removed in the background.",
    stale: "offline for a long time",
  },
  phones: {
    empty: "You have no phones registered yet. Add this org in the yaran app to get notifications on your phone.",
    emptyAction: "Connect a phone",
    remove: "Remove…",
    removeLead: "Remove the phone",
    removeConsequence: "It stops receiving push notifications and can no longer sign in to this org until it is added again.",
    signOut: "Also sign me out everywhere",
    signOutHint: "Ends your Access sessions on every browser and phone. Sessions on machine hostnames you already opened can last until their own sign-in expires.",
    removed: "Removed the phone",
    removedTail: "It no longer receives notifications from this org.",
  },
  connect: {
    phoneHeading: "Connect a phone",
    phoneLead: "On another phone, scan this code with the yaran app.",
    addressLabel: "Org address",
    addressHint: "On this phone? Copy the address, open the yaran app, choose Type the org address, and paste it.",
    stores: "Get the app",
    machineHeading: "Connect a machine",
    machineLead: "On the machine running yaran, run this command, or use Sign in to yaran cloud in the terminal UI's command palette or the web app menu:",
  },
  forbidden: "This page is for org admins. Ask an admin to promote your account if you need it.",
  originRefused: "This form was submitted from another site, so it was refused. Reload the page and try again.",
} as const;
