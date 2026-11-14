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
 * └── src/ui/kit.ts
 * <module-headers:end>
 */
import type { PushState } from "@yaran/protocol";

export const S = {
  skipLink: "Skip to the main content",
  copy: "Copy",
  cancel: "Cancel",
  back: "Back",
  never: "never",
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
  },
  pushState: {
    active: "push working",
    gone: "push stopped: the subscription expired",
    auth_failed: "push stopped: the phone must register again",
    failing: "push is failing",
    none: "push off",
  } satisfies Record<PushState, string>,
  machines: {
    empty: "You have no paired machines yet. Open Connect to pair one.",
    renameHint: "To rename a machine, unpair it and pair it again: the name is part of its hostname, Access application and DNS record.",
    unpair: "Unpair…",
    unpairLead: "Unpair the machine",
    unpairConsequence: "Its tunnel, DNS record and Access application are deleted. The machine stops being reachable from your phones until you pair it again.",
    unpaired: "Unpairing started for the machine",
    unpairedTail: "Its Cloudflare objects are being removed in the background.",
    stale: "offline for a long time",
  },
  phones: {
    empty: "You have no phones registered yet. Open Connect and scan the code with the yaran app.",
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
    phoneLead: "Scan this code with the yaran app, or add the org by its address:",
    stores: "Get the app",
    machineHeading: "Connect a machine",
    machineLead: "On the machine running yaran, run this command, or use Sign in to yaran cloud in the terminal UI's command palette or the web app menu:",
  },
  forbidden: "This page is for org admins. Ask an admin to promote your account if you need it.",
  originRefused: "This form was submitted from another site, so it was refused. Reload the page and try again.",
} as const;
