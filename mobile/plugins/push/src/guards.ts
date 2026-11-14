/**
 * Runtime guards for what native code hands JS: event payload shapes and the D22 rule that no
 * endpoint, push key, auth secret, JWT or cookie ever crosses the bridge.
 *
 * - Events arrive from native code and, for taps, from notification extras; they are checked
 *   before the shell routes anything (T42).
 * - `findForbiddenField` walks a value and names the first forbidden key; the shell refuses a
 *   native result that carries one rather than holding it.
 *
 * <module-headers:begin>
 * Uses:
 * src/guards.ts
 * └── src/definitions.ts
 * External: none
 *
 * Used by:
 * src/guards.ts
 * ├── src/index.ts
 * └── test/guards.test.ts
 * <module-headers:end>
 */
import type {
  EndpointChangedEvent,
  NotificationTappedEvent,
  PendingRegistrationsEvent,
  RegistrationFailedEvent,
} from "./definitions.ts";

/** Field names that would mean key material or a credential reached JS (D22). */
export const FORBIDDEN_BRIDGE_FIELDS = ["endpoint", "keys", "auth", "p256dh", "jwt", "token", "cookie", "authorization"] as const;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const optStr = (v: unknown) => v === undefined || isStr(v);

export function isNotificationTappedEvent(v: unknown): v is NotificationTappedEvent {
  return (
    isRec(v) &&
    isStr(v.orgId) &&
    isStr(v.machineId) &&
    optStr(v.agentId) &&
    optStr(v.tabId) &&
    (v.action === "open" || v.action === "mute_machine") &&
    (v.action === "mute_machine" || isStr(v.agentId))
  );
}

export function isEndpointChangedEvent(v: unknown): v is EndpointChangedEvent {
  return isRec(v) && (v.orgId === null || isStr(v.orgId));
}

export function isRegistrationFailedEvent(v: unknown): v is RegistrationFailedEvent {
  return isRec(v) && isStr(v.orgId) && typeof v.reason === "string";
}

export function isPendingRegistrationsEvent(v: unknown): v is PendingRegistrationsEvent {
  return isRec(v) && Array.isArray(v.orgIds) && v.orgIds.every(isStr);
}

/** The dotted path of the first forbidden key in `value`, or null. */
export function findForbiddenField(value: unknown, path = ""): string | null {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = findForbiddenField(item, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRec(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const here = path ? `${path}.${key}` : key;
    if ((FORBIDDEN_BRIDGE_FIELDS as readonly string[]).includes(key.toLowerCase())) return here;
    const hit = findForbiddenField(child, here);
    if (hit) return hit;
  }
  return null;
}
