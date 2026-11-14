/**
 * Wizard step 9: the admin claim, which closes setup for good.
 *
 * The wizard shows `https://<cp-host>/setup/claim?c=<128-bit code>` (stored hashed, single
 * use, 30 minutes). That path is behind Access, so opening it proves the custom domain,
 * Access, the IdP and the Worker's JWT verification end to end. The verified email must be
 * the admin email typed in the token step; then one D1 batch inserts the admin, closes
 * setup and deletes the claim and lockout keys, `setup.completed` is audited, and
 * workers.dev is disabled by API (a failure there still closes setup; Health offers retry).
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/steps/claim.ts
 * ├── @yaran/protocol:src/index.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/wire-time.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * ├── src/console/route-types.ts
 * ├── src/setup/setup-gate.ts
 * ├── src/setup/steps/common.ts
 * └── src/setup/wizard-state.ts
 * External: none
 *
 * Used by:
 * src/setup/steps/claim.ts
 * ├── src/admin/health.ts
 * ├── src/setup/routes.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import { b64urlEncode } from "@yaran/protocol";
import type { CfTransport } from "../../admin/ports.ts";
import { readKey, writeKeys, writeStatements } from "../../admin/settings-store.ts";
import { workers } from "../../cloudflare/setup-endpoints.ts";
import { wireTime } from "../../admin/wire-time.ts";
import type { Phase07Deps } from "../../console/route-types.ts";
import { sha256Hex } from "../setup-gate.ts";
import { reduce, type SetupRecord } from "../wizard-state.ts";
import { RECORD_KEY, mirroredKeys } from "./common.ts";

const CLAIM_KEY = "setup_claim";
const CLAIM_TTL_S = 30 * 60;

interface StoredClaim {
  hash: string;
  exp: number;
}

/** Issues (or re-issues, replacing the old one) the claim link. */
export async function issueClaim(deps: Phase07Deps, cpHost: string): Promise<string> {
  const code = b64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  const exp = Math.floor(deps.now().getTime() / 1000) + CLAIM_TTL_S;
  await writeKeys(deps.db, { [CLAIM_KEY]: { hash: await sha256Hex(code), exp } satisfies StoredClaim }, "setup", deps.now());
  return `https://${cpHost}/setup/claim?c=${encodeURIComponent(code)}`;
}

export type ClaimOutcome = { ok: true; record: SetupRecord } | { ok: false };

/** Disables workers.dev and previews; false when Cloudflare refused (Health retries). */
export async function disableWorkersDev(cf: CfTransport, accountId: string, script: string): Promise<boolean> {
  try {
    await workers.setSubdomain(cf, accountId, script, false);
    return true;
  } catch {
    return false;
  }
}

export async function redeemClaim(deps: Phase07Deps, record: SetupRecord, code: string, verifiedEmail: string | null, cf: () => Promise<CfTransport>): Promise<ClaimOutcome> {
  const stored = await readKey<StoredClaim>(deps.db, CLAIM_KEY);
  const now = deps.now();
  const valid =
    record.step === "claim" &&
    stored !== undefined &&
    stored.exp > now.getTime() / 1000 &&
    stored.hash === (await sha256Hex(code)) &&
    verifiedEmail !== null &&
    verifiedEmail.toLowerCase() === record.admin_email;
  if (!valid) return { ok: false };

  const disabled = await disableWorkersDev(await cf(), record.account_id!, record.script_name!);
  const t = reduce(record, { kind: "admin_claimed", closed_at: wireTime(now), workers_dev_disabled: disabled });
  if (!t.ok) return { ok: false };
  const email = record.admin_email!;
  const at = Math.floor(now.getTime() / 1000);
  const db = deps.db;
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO users (id, email, slug, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)")
      .bind(deps.newId(), email, deps.provisioning.deriveUserSlug(email), at),
    db.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE email = ?").bind(email),
    ...writeStatements(
      db,
      { [RECORD_KEY]: t.record, ...mirroredKeys(t.record), setup_state: "closed", instance_id: randomHex(4), workers_dev_disabled: disabled },
      "setup",
      now,
    ),
    db.prepare("DELETE FROM settings WHERE key IN (?, ?)").bind(CLAIM_KEY, "setup_code_failures"),
  ]);
  await deps.audit({ actor: { kind: "setup" }, action: "setup.completed", target: { kind: "org" }, outcome: "ok", detail: { workers_dev_disabled: disabled } });
  return { ok: true, record: t.record };
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
