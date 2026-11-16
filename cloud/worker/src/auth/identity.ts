/**
 * Maps a verified Access identity to a `users` row: first-sight provisioning, the
 * disabled-user refusal, and the throttled last-seen stamp.
 *
 * The email (trimmed, lowercased) is the key. A first sight after setup creates a plain
 * `user`; the role comes only from D1, never from a claim (Access trims custom claims past
 * about 1,000 bytes). A slug collision appends `-2` … `-99`, then `-<4 hex>`.
 *
 * <module-headers:begin>
 * Uses:
 * src/auth/identity.ts
 * ├── src/db/client.ts
 * ├── src/db/users.ts
 * ├── src/http/context.ts
 * ├── src/http/responses.ts
 * └── src/provisioning/naming.ts
 * External: none
 *
 * Used by:
 * src/auth/identity.ts
 * ├── src/auth/authorize.ts
 * └── test/identity.test.ts
 * <module-headers:end>
 */
import { all } from "../db/client.ts";
import { getUserByEmail, insertUser, LAST_SEEN_THROTTLE_S, normalizeEmail, touchUserSeen, type UserRow } from "../db/users.ts";
import type { AccessClaims } from "../http/context.ts";
import { HttpError } from "../http/responses.ts";
import { deriveUserSlug, userSlugCandidate } from "../provisioning/naming.ts";

/** Picks the first free slug among base, base-2 … base-99, else base-<4 hex> (05's candidates). */
export function pickSlug(base: string, taken: ReadonlySet<string>): string {
  const random = () => crypto.getRandomValues(new Uint16Array(1))[0]! / 0x10000;
  for (let n = 1; n <= 99; n++) {
    const candidate = userSlugCandidate(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  return userSlugCandidate(base, 100, random);
}

async function createUser(db: D1Database, claims: AccessClaims, now: number): Promise<UserRow> {
  const email = normalizeEmail(claims.email);
  const base = await deriveUserSlug(email);
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = new Set((await all<{ slug: string }>(db,
      "SELECT slug FROM users WHERE slug = ? OR slug LIKE ? ESCAPE '\\'", base, `${base.replace(/[\\%_]/g, "\\$&")}-%`)).map((r) => r.slug));
    const slug = pickSlug(base, taken);
    await insertUser(db, { id: crypto.randomUUID(), email, slug, role: "user", accessSub: claims.sub, now });
    const row = await getUserByEmail(db, email);
    if (row) return row;
  }
  throw new HttpError("conflict", "A user record could not be created; try again.");
}

/** The active user behind `claims`, created on first sight once setup is closed. */
export async function resolveUser(db: D1Database, claims: AccessClaims, setupClosed: boolean, now: number): Promise<UserRow> {
  let user = await getUserByEmail(db, claims.email);
  if (!user) {
    if (!setupClosed) throw new HttpError("setup_incomplete");
    user = await createUser(db, claims, now);
  }
  if (user.status === "disabled") throw new HttpError("user_disabled", "This account has been disabled by an administrator.");
  if (user.last_seen_at === null || user.last_seen_at <= now - LAST_SEEN_THROTTLE_S) await touchUserSeen(db, user.id, now);
  return user;
}

