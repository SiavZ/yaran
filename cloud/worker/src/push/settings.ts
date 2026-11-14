/**
 * Typed access to 02's `Settings.push` and the two policy questions every push path asks:
 * is this device muted, and may this channel's relay be used.
 *
 * The settings row is written and schema-validated by 04/07; this module supplies the
 * defaults for a row never written and re-checks the bounds, so a bad stored value is a
 * loud error rather than a silent default (04 §12).
 *
 * - Pure. One home for the mute rule and the relay rule, shared by the endpoint policy,
 *   fan-out and the queue consumer.
 *
 * <module-headers:begin>
 * Uses:
 * cloud/worker/src/push/settings.ts
 * └── cloud/worker/src/push/seams.ts
 * External: @yaran/protocol
 *
 * Used by:
 * cloud/worker/src/push/settings.ts
 * ├── cloud/worker/src/push/consumer.ts
 * ├── cloud/worker/src/push/endpoint_policy.ts
 * ├── cloud/worker/src/push/events_route.ts
 * ├── cloud/worker/src/push/fanout.ts
 * ├── cloud/worker/src/push/index.ts
 * ├── cloud/worker/src/push/test_route.ts
 * ├── yaran-worker-push-tests:helpers/fakes.ts
 * └── yaran-worker-push-tests:migration.test.ts
 * <module-headers:end>
 */
import type { PushChannel } from "@yaran/protocol";
import type { PushSettings } from "./seams.ts";

export const DEFAULT_PUSH_SETTINGS: PushSettings = Object.freeze({
  enabled: true,
  detail: "names",
  ttl_seconds: 3600,
  relay_allowed: true,
  allowed_relays: [],
}) as PushSettings;

export const TTL_MIN_S = 60;
export const TTL_MAX_S = 86_400;

/** The org's push settings; throws when a stored value is out of 02's bounds. */
export function pushSettings(raw: unknown): PushSettings {
  if (raw === undefined || raw === null) return DEFAULT_PUSH_SETTINGS;
  const v = raw as Partial<PushSettings>;
  const ok =
    typeof v.enabled === "boolean" &&
    (v.detail === "names" || v.detail === "minimal") &&
    Number.isInteger(v.ttl_seconds) &&
    v.ttl_seconds! >= TTL_MIN_S &&
    v.ttl_seconds! <= TTL_MAX_S &&
    typeof v.relay_allowed === "boolean" &&
    Array.isArray(v.allowed_relays) &&
    v.allowed_relays.length <= 20 &&
    v.allowed_relays.every((o) => typeof o === "string" && /^https:\/\/[^/:?#]+$/.test(o));
  if (!ok) throw new Error("the stored push settings are invalid; fix them in the admin console");
  return v as PushSettings;
}

/** Whether a channel reaches the device through the publisher relay. */
export function isRelayChannel(channel: PushChannel): boolean {
  switch (channel) {
    case "apns_relay":
    case "fcm_relay":
      return true;
    case "unifiedpush":
    case "fcm_embedded":
      return false;
    default:
      return assertNever(channel);
  }
}

export type RelayVerdict = "ok" | "disabled" | "not_allowlisted";

/** 02's relay rule: relay channels only while allowed, and only to allowlisted origins. */
export function relayVerdict(settings: PushSettings, channel: PushChannel, origin: string): RelayVerdict {
  if (!isRelayChannel(channel)) return "ok";
  if (!settings.relay_allowed) return "disabled";
  if (settings.allowed_relays.length > 0 && !settings.allowed_relays.includes(origin)) return "not_allowlisted";
  return "ok";
}

/** 02's mute rule for one device and machine at `now` (Unix seconds). */
export function isMuted(
  device: { mute_all: boolean; muted_until: number | null },
  machineMuted: boolean,
  now: number,
): boolean {
  if (device.mute_all || machineMuted) return true;
  return device.muted_until !== null && now < device.muted_until;
}

export function assertNever(value: never): never {
  throw new Error(`unhandled value ${String(value)}`);
}
