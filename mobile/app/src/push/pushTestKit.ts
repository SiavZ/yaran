/**
 * Test kit for the shell's push orchestration: a scripted fake of the `Push` plugin and of
 * Phase 15's `Session`, and 02-shaped `Device` and `Meta` builders.
 *
 * - Imported by the `*.test.ts(x)` files only; never by product code.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/pushTestKit.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── @yaran/push:src/index.ts
 * ├── src/push/pushPermission.ts
 * └── src/push/pushRegistration.ts
 * External: none
 *
 * Used by:
 * src/push/pushTestKit.ts
 * ├── src/push/NotificationSettingsSection.test.tsx
 * ├── src/push/notificationTap.test.ts
 * ├── src/push/pushPermission.test.ts
 * ├── src/push/pushRegistration.test.ts
 * └── src/push/pushWiring.test.ts
 * <module-headers:end>
 */
import type { Device, Meta } from "@yaran/protocol";
import type { LocalPushState, PushPlugin, RegisterDeviceOptions, RegisterDeviceResult } from "@yaran/push";
import type { OrgRowState } from "./pushPermission.ts";
import type { ApiResult, PushOrg, SessionApi } from "./pushRegistration.ts";

export const VAPID = "BGuXrBERTW6sUC8-SWAenyGmbmQg3GyikfpRKoD9PWtulg4KijYaQ6d6wd5EVYTC12m3K0K5IRf66r20urk2rG0";
export const ROTATED = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
export const MACHINE = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";

export function device(overrides: Partial<Device> = {}): Device {
  return {
    id: "c0ffee00-1234-4abc-bdef-0123456789ab",
    install_id: "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
    device_key_fingerprint: "K7QF-3MZD-W2PA-HX5R-LC4N-TB6E",
    platform: "android",
    flavor: "foss",
    form_factor: "phone",
    app_version: "1.0.0",
    label: "Pixel",
    push: { kind: "webpush", channel: "unifiedpush", endpoint_host: "ntfy.example.com", vapid_public_key: VAPID },
    push_state: "active",
    mute_all: false,
    muted_until: null,
    muted_machine_ids: [],
    created_at: "2026-11-14T12:00:00Z",
    last_seen_at: "2026-11-14T12:00:00Z",
    current: true,
    ...overrides,
  };
}

export function meta(overrides: Partial<Meta> = {}): Meta {
  return {
    service: "yaran-cloud",
    protocol: { min: 1, max: 1 },
    setup: "closed",
    worker: { version: "1.0.0" },
    capabilities: ["push.webpush"],
    push: { enabled: true, vapid_public_key: VAPID },
    ...overrides,
  } as Meta;
}

export const ORG: PushOrg = {
  orgId: "org-1",
  orgUrl: "https://yaran.example.com",
  orgName: "Acme",
  installId: "9b8a7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d",
  label: "Pixel",
  machines: [{ id: MACHINE, name: "build-box" }],
};

export interface Call {
  method: string;
  args: unknown;
}

export function fakePush(script: {
  permission?: "granted" | "denied" | "prompt" | "prompt-with-rationale";
  local?: Partial<LocalPushState>;
  register?: (o: RegisterDeviceOptions) => RegisterDeviceResult;
  pending?: string[];
} = {}) {
  const calls: Call[] = [];
  const rec = (method: string) => async (args?: unknown) => {
    calls.push({ method, args });
  };
  const push = {
    checkPermission: async () => ({ notifications: script.permission ?? "granted" }),
    requestPermission: async () => ({ notifications: script.permission ?? "granted" }),
    openNotificationSettings: rec("openNotificationSettings"),
    listDistributors: async () => ({ distributors: [], selected: null, embedded: null }),
    selectDistributor: rec("selectDistributor"),
    registerDevice: async (o: RegisterDeviceOptions) => {
      calls.push({ method: "registerDevice", args: o });
      return script.register ? script.register(o) : { outcome: "ok" as const, device: device() };
    },
    localState: async () => ({
      subscribed: true,
      channel: "unifiedpush" as const,
      endpointHost: "ntfy.example.com",
      vapidPublicKey: VAPID,
      relayKeyId: null,
      relayKeyCurrent: null,
      ...script.local,
    }),
    forgetOrg: rec("forgetOrg"),
    setLocalMutes: rec("setLocalMutes"),
    cacheMachineNames: rec("cacheMachineNames"),
    setVisibleAgent: rec("setVisibleAgent"),
    clearDelivered: rec("clearDelivered"),
    drainPendingRegistrations: async () => ({ orgIds: script.pending ?? [] }),
    addListener: async () => ({ remove: async () => {} }),
  } as unknown as PushPlugin;
  return { push, calls };
}

export function fakeSession(answer: (method: string, path: string, body?: unknown) => ApiResult, metaValue: Meta = meta()) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const session: SessionApi = {
    meta: async () => metaValue,
    request: async ({ method, path, body }) => {
      calls.push({ method, path, body });
      return answer(method, path, body);
    },
  };
  return { session, calls };
}

export const listing = (...items: Device[]): ApiResult => ({ kind: "ok", status: 200, body: { items, next_cursor: null } });

/** One of every row state, for exhaustive rendering tests. */
export const ALL_STATES: OrgRowState[] = [
  { kind: "active" },
  { kind: "needs_permission" },
  { kind: "no_distributor" },
  { kind: "push_unavailable", reason: "no Play services" },
  { kind: "registration_failed", reason: "conflict" },
  { kind: "refresh_pending" },
  { kind: "delivery_failing" },
  { kind: "org_disabled" },
  { kind: "muted", until: null },
  { kind: "muted", until: "2026-11-14T13:00:00Z" },
  { kind: "turned_off" },
];
