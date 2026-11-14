/**
 * The `Push` plugin's TypeScript contract: the one API the shell's push orchestration calls on
 * Android (UnifiedPush, embedded FCM or relay-held FCM) and iOS (APNs through the relay).
 *
 * Native code obtains the subscription, mints relay endpoints, fills 02's `DeviceRegistration`
 * `push` member and `device_key`, and sends W12 through Phase 15's native org client. JS decides
 * when and for which org, owns the row states, and reads back only non-secret facts.
 *
 * - D22: no type here carries an endpoint, a push key, an auth secret, a JWT or a cookie; the
 *   guard test in test/guards.test.ts fails if one is added.
 * - Wire types come from `@yaran/protocol`; none is redeclared.
 *
 * <module-headers:begin>
 * Uses:
 * src/definitions.ts
 * └── @yaran/protocol:src/index.ts
 * External: @capacitor/core
 *
 * Used by:
 * src/definitions.ts
 * ├── src/guards.ts
 * ├── src/index.ts
 * ├── src/web.ts
 * └── test/guards.test.ts
 * <module-headers:end>
 */
import type { PluginListenerHandle } from "@capacitor/core";
import type { Device, DeviceRegistration, ErrorCode, InstallId, PushChannel } from "@yaran/protocol";

/** Capacitor's permission states for the `notifications` alias. */
export type NotificationPermission = "granted" | "denied" | "prompt" | "prompt-with-rationale";

/** 02's per-device mute fields, as the Worker's device record holds them. */
export type PushMutes = Pick<DeviceRegistration, "mute_all" | "muted_until" | "muted_machine_ids">;

export interface RegisterDeviceOptions {
  orgId: string;
  /** 02 `InstallId` from Phase 15's `Session.installId` (an identifier, not a credential). */
  installId: InstallId;
  label: string;
  locale?: string;
  mutes: PushMutes;
  /** Re-register with `push: {kind: "none"}` and delete the local push keys. */
  pushOff?: boolean;
  /** `Meta.push.vapid_public_key`, read through `Session.meta`; a public key. */
  vapidPublicKey?: string | null;
}

/** Why push cannot work on this phone right now. */
export type RegisterDeviceResult =
  | { outcome: "ok"; device: Device }
  | { outcome: "api_error"; status: number; code: ErrorCode | string }
  | { outcome: "session_expired" }
  | { outcome: "device_revoked" }
  | { outcome: "offline" }
  | { outcome: "tls_error" }
  | { outcome: "refused" }
  | { outcome: "protocol_unsupported" }
  | { outcome: "needs_permission" }
  | { outcome: "no_distributor" }
  | { outcome: "push_unavailable"; reason: string }
  | { outcome: "registration_failed"; reason: string };

/** Non-secret facts for reconciliation. */
export interface LocalPushState {
  subscribed: boolean;
  channel: PushChannel | null;
  endpointHost: string | null;
  vapidPublicKey: string | null;
  relayKeyId: string | null;
  /** Relay channels only: whether the stored key id still equals the relay's; null otherwise. */
  relayKeyCurrent: boolean | null;
}

export interface DistributorList {
  /** UnifiedPush distributor package names (Android); empty on iOS. */
  distributors: string[];
  selected: string | null;
  /** This app's own embedded FCM distributor (`play`), or null. */
  embedded: string | null;
}

export interface MachineNames {
  orgId: string;
  orgName: string;
  machines: { id: string; name: string }[];
}

export interface AgentRef {
  orgId: string;
  machineId: string;
  agentId: string;
  tabId?: string;
}

export interface ClearDeliveredOptions {
  orgId: string;
  machineId: string;
  agentId?: string;
  tabId?: string;
}

export interface NotificationTappedEvent {
  orgId: string;
  machineId: string;
  agentId?: string;
  tabId?: string;
  action: "open" | "mute_machine";
}

/** `orgId` null means every org (an APNs token change). */
export interface EndpointChangedEvent {
  orgId: string | null;
}

export interface RegistrationFailedEvent {
  orgId: string;
  reason: string;
}

export interface PendingRegistrationsEvent {
  orgIds: string[];
}

export interface PushPlugin {
  checkPermission(): Promise<{ notifications: NotificationPermission }>;
  requestPermission(): Promise<{ notifications: NotificationPermission }>;
  openNotificationSettings(): Promise<void>;
  listDistributors(): Promise<DistributorList>;
  selectDistributor(options: { distributor: string }): Promise<void>;
  registerDevice(options: RegisterDeviceOptions): Promise<RegisterDeviceResult>;
  localState(options: { orgId: string }): Promise<LocalPushState>;
  /** Deletes this org's local push keys and mirrors; the Worker is not called. */
  forgetOrg(options: { orgId: string }): Promise<void>;
  setLocalMutes(options: { orgId: string; mutes: PushMutes }): Promise<void>;
  cacheMachineNames(options: MachineNames): Promise<void>;
  /** The agent tab machine-view shows, or `{}` when none. */
  setVisibleAgent(options: AgentRef | Record<string, never>): Promise<void>;
  clearDelivered(options: ClearDeliveredOptions): Promise<void>;
  /** Orgs whose endpoint changed while the WebView was not running (Android). */
  drainPendingRegistrations(): Promise<{ orgIds: string[] }>;

  addListener(event: "notificationTapped", listener: (e: NotificationTappedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "endpointChanged", listener: (e: EndpointChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "registrationFailed", listener: (e: RegistrationFailedEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: "pendingRegistrations", listener: (e: PendingRegistrationsEvent) => void): Promise<PluginListenerHandle>;
}
