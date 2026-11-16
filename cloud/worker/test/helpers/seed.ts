/**
 * Test seeders: settings for a closed or open setup, users and machines.
 *
 * <module-headers:begin>
 * Uses:
 * test/helpers/seed.ts
 * ├── src/db/client.ts
 * ├── src/db/machines.ts
 * ├── src/db/settings.ts
 * └── src/db/users.ts
 * External: cloudflare:test
 *
 * Used by:
 * test/helpers/seed.ts
 * ├── test/access-jwt.test.ts
 * ├── test/audit.test.ts
 * ├── test/body.test.ts
 * ├── test/data-key.test.ts
 * ├── test/helpers/access.ts
 * ├── test/helpers/app.ts
 * ├── test/helpers/deps.ts
 * ├── test/helpers/machine.ts
 * ├── test/helpers/matrix.ts
 * ├── test/helpers/worker.ts
 * ├── test/host-guard.test.ts
 * ├── test/identity.test.ts
 * ├── test/machine-signature.test.ts
 * ├── test/migrations.test.ts
 * ├── test/no-secret-leak.test.ts
 * ├── test/phase06/fakes.ts
 * ├── test/phase06/harness.ts
 * ├── test/prov-context.test.ts
 * ├── test/purge.test.ts
 * ├── test/rate-limit.test.ts
 * ├── test/responses.test.ts
 * ├── test/router.test.ts
 * ├── test/secrets.test.ts
 * └── test/settings.test.ts
 * <module-headers:end>
 */
import { env } from "cloudflare:test";
import { insertMachine, type MachineStatus } from "../../src/db/machines.ts";
import { setSetting } from "../../src/db/settings.ts";
import { insertUser, type Role } from "../../src/db/users.ts";
import { run } from "../../src/db/client.ts";

export const CP_HOST = "cp.example.com";
export const TEAM = "acme.cloudflareaccess.com";
export const AUD = "a".repeat(64);
export const NOW = 1_731_571_200;

export async function closeSetup(host = CP_HOST): Promise<void> {
  await setSetting(env.DB, "setup_state", "closed", "test", NOW);
  await setSetting(env.DB, "control_plane_host", host, "test", NOW);
  await setSetting(env.DB, "team_domain", TEAM, "test", NOW);
  await setSetting(env.DB, "control_plane_aud", AUD, "test", NOW);
  // The Cloudflare identifiers setup records, which provisioning needs.
  await setSetting(env.DB, "instance_id", "0123abcd", "test", NOW);
  await setSetting(env.DB, "account_id", "acc123", "test", NOW);
  await setSetting(env.DB, "zone_id", "zone123", "test", NOW);
  await setSetting(env.DB, "zone_name", "example.com", "test", NOW);
}

export async function openSetup(): Promise<void> {
  await setSetting(env.DB, "setup_state", "open", "test", NOW);
}

let counter = 0;

export async function seedUser(o: { email?: string; role?: Role; disabled?: boolean } = {}): Promise<{ id: string; email: string }> {
  counter++;
  const id = crypto.randomUUID();
  const email = o.email ?? `user${counter}@example.com`;
  await insertUser(env.DB, { id, email, slug: `seed-${counter}`, role: o.role ?? "user", accessSub: `sub-${counter}`, now: NOW });
  if (o.disabled) await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", id);
  return { id, email };
}

export async function seedMachine(o: { owner: string; publicKey: Uint8Array; status?: MachineStatus; id?: string }): Promise<string> {
  counter++;
  const id = o.id ?? crypto.randomUUID();
  await insertMachine(env.DB, {
    id, instanceId: "0123abcd", ownerUserId: o.owner, name: `m${counter}`, slug: `m${counter}`,
    hostname: `m${counter}-x.example.com`, publicKey: o.publicKey, originPort: 3890, now: NOW,
  });
  if (o.status && o.status !== "provisioning") await run(env.DB, "UPDATE machines SET status = ? WHERE id = ?", o.status, id);
  return id;
}
