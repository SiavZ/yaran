/**
 * Push collapse topic and per-kind delivery parameters (Design §9).
 *
 * topic(m, a, t) is the first 32 characters of base64url(SHA-256("yaran-topic-v1\n" + m +
 * "\n" + a + "\n" + (t or ""))): it fits RFC 8030's Topic rule and doubles as the
 * apns-collapse-id and the Android notification tag, so a repeat for one agent tab
 * replaces the previous notification.
 *
 * - Pure apart from a WebCrypto SHA-256.
 *
 * <module-headers:begin>
 * Uses:
 * src/push/topic.ts
 * ├── src/b64url.ts
 * └── src/generated/types.ts
 * External: none
 *
 * Used by:
 * src/push/topic.ts
 * ├── src/index.ts
 * ├── src/push/apns.ts
 * └── test/push.test.ts
 * <module-headers:end>
 */
import { b64urlEncode, sha256, utf8 } from "../b64url.ts";
import type { PushKind } from "../generated/types.ts";

export const PUSH_TOPIC_TAG = "yaran-topic-v1";
export type Urgency = "very-low" | "low" | "normal" | "high";

/** The Topic for one agent tab (t omitted for the slot tab). */
export async function pushTopic(m: string, a: string, t?: string): Promise<string> {
  const digest = await sha256(utf8.encode(`${PUSH_TOPIC_TAG}\n${m}\n${a}\n${t ?? ""}`));
  return b64urlEncode(digest).slice(0, 32);
}

export interface Delivery {
  urgency: Urgency;
  ttl: number;
  /** Whether the message carries a Topic (every kind but test). */
  topic: boolean;
  /** Visible notification, or a background message that only removes one. */
  visible: boolean;
}

/** The Web Push headers' inputs for a payload kind; ttlSetting is Settings.push.ttl_seconds. */
export function pushDelivery(kind: PushKind, ttlSetting: number): Delivery {
  switch (kind) {
    case "attention_raised":
      return { urgency: "high", ttl: ttlSetting, topic: true, visible: true };
    case "attention_cleared":
      return { urgency: "very-low", ttl: ttlSetting, topic: true, visible: false };
    case "agent_exited_badly":
      return { urgency: "high", ttl: ttlSetting, topic: true, visible: true };
    case "test":
      return { urgency: "normal", ttl: 300, topic: false, visible: true };
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled push kind ${String(value)}`);
}
