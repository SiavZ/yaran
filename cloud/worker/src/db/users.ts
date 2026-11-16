/**
 * The `users` repository: lookup, first-sight creation, role and status changes, and the
 * throttled last-seen stamp.
 *
 * Emails are stored trimmed and lowercased (a CHECK enforces it). Role and status changes
 * are guarded `UPDATE`s that report whether they applied; the last-admin rule and the
 * audit row belong to the caller (07).
 *
 * <module-headers:begin>
 * Uses:
 * src/db/users.ts
 * └── src/db/client.ts
 * External: none
 *
 * Used by:
 * src/db/users.ts
 * ├── src/auth/identity.ts
 * ├── src/http/context.ts
 * ├── test/helpers/seed.ts
 * ├── test/identity.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */
import { one, run } from "./client.ts";

export type Role = "user" | "admin";
export type UserStatus = "active" | "disabled";

export interface UserRow {
  id: string;
  email: string;
  slug: string;
  role: Role;
  status: UserStatus;
  access_sub: string | null;
  created_at: number;
  last_seen_at: number | null;
}

/** last_seen_at is written at most once per this many seconds, to spare D1 writes. */
export const LAST_SEEN_THROTTLE_S = 300;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return one<UserRow>(db, "SELECT * FROM users WHERE id = ?", id);
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return one<UserRow>(db, "SELECT * FROM users WHERE email = ?", normalizeEmail(email));
}

/**
 * Inserts a user unless the email or slug is taken. Returns true when this call created
 * the row; false means another request won the email, or the slug collided.
 */
export async function insertUser(
  db: D1Database, u: { id: string; email: string; slug: string; role: Role; accessSub: string | null; now: number },
): Promise<boolean> {
  return (await run(db,
    "INSERT OR IGNORE INTO users (id, email, slug, role, status, access_sub, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)",
    u.id, normalizeEmail(u.email), u.slug, u.role, u.accessSub, u.now, u.now)) === 1;
}

/** Stamps last_seen_at unless it was stamped within the throttle window. */
export async function touchUserSeen(db: D1Database, id: string, now: number): Promise<boolean> {
  return (await run(db,
    "UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
    now, id, now - LAST_SEEN_THROTTLE_S)) === 1;
}

export async function setUserRole(db: D1Database, id: string, from: Role, to: Role): Promise<boolean> {
  return (await run(db, "UPDATE users SET role = ? WHERE id = ? AND role = ?", to, id, from)) === 1;
}

export async function setUserStatus(db: D1Database, id: string, from: UserStatus, to: UserStatus): Promise<boolean> {
  return (await run(db, "UPDATE users SET status = ? WHERE id = ? AND status = ?", to, id, from)) === 1;
}
