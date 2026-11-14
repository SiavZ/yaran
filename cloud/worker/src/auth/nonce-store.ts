/**
 * Single-use machine nonces in D1 (`machine_nonces`), the replay half of the signed
 * machine API.
 *
 * A nonce is recorded with `INSERT OR IGNORE`; zero changed rows means it was seen before.
 * The scope is the machine id, or `claim:<code>` on the claim route. Rows live until the
 * request timestamp plus 600 s and are purged by cron in bounded chunks.
 *
 * - Called only after the signature verified, so a stranger cannot spend D1 writes here.
 * - Strongly consistent only because every query reaches the D1 primary (no Sessions API).
 *
 * <module-headers:begin>
 * Uses:
 * src/auth/nonce-store.ts
 * ├── @yaran/protocol:src/index.ts
 * └── src/db/client.ts
 * External: none
 *
 * Used by:
 * src/auth/nonce-store.ts
 * ├── src/auth/machine-signature.ts
 * └── src/scheduled/purge.ts
 * <module-headers:end>
 */
import type { NonceStore } from "@yaran/protocol";
import { run } from "../db/client.ts";

export function d1NonceStore(db: D1Database): NonceStore {
  return {
    async recordIfNew(scope, nonce, expiresAt) {
      return (await run(db, "INSERT OR IGNORE INTO machine_nonces (machine_id, nonce, expires_at) VALUES (?, ?, ?)",
        scope, nonce, expiresAt)) === 1;
    },
  };
}

/** Deletes up to `limit` expired nonces; returns how many went. */
export async function purgeExpiredNonces(db: D1Database, now: number, limit: number): Promise<number> {
  return run(db,
    `DELETE FROM machine_nonces WHERE (machine_id, nonce) IN
       (SELECT machine_id, nonce FROM machine_nonces WHERE expires_at < ? LIMIT ?)`,
    now, limit);
}
