/**
 * One-shot outcome messages across a post/redirect/get, carried in a short-lived cookie.
 *
 * After a destructive action the next page must say what happened, naming the target,
 * because a row vanishing is too small to trust. The message rides a `__Host-` cookie the
 * server alone sets (HttpOnly, SameSite=Strict, 60 seconds) and the next page clears it, so
 * no outcome text ever comes from a URL a third party could craft.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/console/flash.ts
 * ├── src/console/admin-pages.tsx
 * ├── src/console/admin-routes.ts
 * ├── src/console/flash-notice.tsx
 * ├── src/console/routes.ts
 * └── src/console/user-pages.tsx
 * <module-headers:end>
 */
export type FlashKind =
  | "unpaired"
  | "phone_removed"
  | "user_disabled"
  | "user_enabled"
  | "role_changed"
  | "last_admin"
  | "user_gone"
  | "machine_revoked"
  | "machine_rotated"
  | "device_removed"
  | "settings_saved"
  | "workers_dev_disabled"
  | "workers_dev_failed"
  | "token_replaced"
  | "update_checked";

export interface Flash {
  kind: FlashKind;
  /** The name the message is about (machine, phone label, email), rendered as a chip. */
  target?: string;
  /** Extra facts, e.g. which settings side effects failed. */
  extra?: string[];
}

const NAME = "__Host-yaran-flash";

export function setFlash(flash: Flash): string {
  return `${NAME}=${encodeURIComponent(JSON.stringify(flash))}; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearFlash(): string {
  return `${NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function readFlash(request: Request): Flash | null {
  const raw = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${NAME}=`))
    ?.slice(NAME.length + 1);
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw)) as Flash;
    return typeof v.kind === "string" ? v : null;
  } catch {
    return null;
  }
}
