/**
 * How the publisher relay wraps an org's Web Push ciphertext for APNs and, in the G5
 * fallback, FCM (Design §9 "Relay → APNs" / "Relay → FCM"). The relay never decrypts:
 * it forwards `y` (the whole aes128gcm body, base64url) and `r` (registration id), and
 * the device's NSE or background handler decrypts.
 *
 * - high/normal urgency is an alert the NSE rewrites; low/very-low is a background push.
 * - Pure.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/apns.ts
 * ├── src/generated/types.ts
 * └── src/push/topic.ts
 * External: none
 *
 * Used by:
 * src/push/apns.ts
 * ├── src/index.ts
 * └── test/push.test.ts
 * <module-headers:end>
 */
import type { RelayApnsAlert, RelayApnsBackground, RelayFcmMessage } from "../generated/types.ts";
import type { Urgency } from "./topic.ts";

export interface RelayInput {
  urgency: Urgency;
  /** The Web Push Topic, or null (test pushes carry none). */
  topic: string | null;
  /** TTL in seconds from the Web Push request. */
  ttl: number;
  registrationId: string;
  /** base64url of the full aes128gcm body. */
  body: string;
  appId: string;
  /** Unix seconds, for apns-expiration. */
  now: number;
}

/** The APNs request body and headers for one relayed message. */
export function buildRelayApns(i: RelayInput): { headers: Record<string, string>; payload: RelayApnsAlert | RelayApnsBackground } {
  const alert = i.urgency === "high" || i.urgency === "normal";
  const headers: Record<string, string> = {
    "apns-push-type": alert ? "alert" : "background",
    "apns-priority": i.urgency === "high" ? "10" : "5",
    "apns-expiration": String(i.ttl === 0 ? 0 : i.now + i.ttl),
    "apns-topic": i.appId,
  };
  if (i.topic !== null) headers["apns-collapse-id"] = i.topic;
  const relay = { v: 1 as const, r: i.registrationId, y: i.body };
  const payload: RelayApnsAlert | RelayApnsBackground = alert
    ? {
        aps: {
          alert: { "title-loc-key": "PUSH_GENERIC_TITLE", "loc-key": "PUSH_GENERIC_BODY" },
          "mutable-content": 1,
          sound: "default",
          "thread-id": i.topic ?? "yaran",
        },
        ...relay,
      }
    : { aps: { "content-available": 1 }, ...relay };
  return { headers, payload };
}

/** The FCM data message for the G5 fallback channel (fcm_relay). */
export function buildRelayFcm(i: Omit<RelayInput, "appId" | "now">): RelayFcmMessage {
  const android: RelayFcmMessage["android"] = { priority: i.urgency === "high" ? "high" : "normal", ttl: `${i.ttl}s` };
  if (i.topic !== null) android.collapse_key = i.topic;
  return { data: { v: "1", r: i.registrationId, y: i.body }, android };
}
