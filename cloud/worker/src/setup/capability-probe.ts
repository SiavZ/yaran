/**
 * Token capability probe: one harmless read per permission-manifest row.
 *
 * Before the wizard stores a token it proves every permission the Worker will use, so a
 * missing one is named now (with its purpose and the template link) instead of failing on
 * the first machine pairing. A refusal (`auth`) marks the row missing; any other failure is
 * reported as "could not check" with the sanitized reason, never as a pass.
 *
 * - Also the account discovery step: `GET /accounts`, falling back to an admin-supplied
 *   account id verified by `tokens/verify` (gate G9 decides which one account tokens get).
 *
 * <module-headers:begin>
 * Uses:
 * src/setup/capability-probe.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/errors.ts
 * ├── src/cloudflare/setup-endpoints.ts
 * └── src/setup/token-template.ts
 * External: none
 *
 * Used by:
 * src/setup/capability-probe.ts
 * ├── src/admin/api-token.ts
 * ├── src/console/admin-pages-2.tsx
 * ├── src/setup/pages.tsx
 * ├── src/setup/routes.ts
 * └── test/setup-steps.test.ts
 * <module-headers:end>
 */
import { CfApiError } from "../cloudflare/errors.ts";
import { assertNever, type CfTransport } from "../admin/ports.ts";
import { accounts, access, idp, tunnels, workers, zones } from "../cloudflare/setup-endpoints.ts";
import { PERMISSIONS, type PermissionRow } from "./token-template.ts";

export type ProbeOutcome = "ok" | "missing" | "unchecked";

export interface ProbeRow {
  permission: PermissionRow;
  outcome: ProbeOutcome;
  reason?: string;
}

export type ProbeKey = "tunnels" | "access_apps" | "access_org" | "worker_script" | "dns" | "zones";

async function runProbe(cf: CfTransport, key: ProbeKey, accountId: string, scriptName: string): Promise<void> {
  switch (key) {
    case "tunnels":
      await tunnels.probe(cf, accountId);
      return;
    case "access_apps":
      await access.listApps(cf, accountId);
      return;
    case "access_org":
      await idp.list(cf, accountId);
      return;
    case "worker_script":
      await workers.getScriptSettings(cf, accountId, scriptName);
      return;
    case "zones":
      await zones.list(cf);
      return;
    case "dns": {
      const first = (await zones.list(cf))[0];
      if (first) await zones.probeDns(cf, first.id);
      return;
    }
    default:
      assertNever(key);
  }
}

/** Runs every manifest row's probe; rows run one after another to stay inside the API budget. */
export async function probeCapabilities(cf: CfTransport, accountId: string, scriptName: string, rows: readonly PermissionRow[] = PERMISSIONS): Promise<ProbeRow[]> {
  const out: ProbeRow[] = [];
  for (const permission of rows) {
    try {
      await runProbe(cf, permission.probe as ProbeKey, accountId, scriptName);
      out.push({ permission, outcome: "ok" });
    } catch (e) {
      if (e instanceof CfApiError && e.kind === "auth") out.push({ permission, outcome: "missing" });
      else out.push({ permission, outcome: "unchecked", reason: e instanceof CfApiError ? `${e.kind} (HTTP ${e.status})` : "network error" });
    }
  }
  return out;
}

export function probePassed(rows: readonly ProbeRow[]): boolean {
  return rows.every((r) => r.outcome === "ok");
}

/** The account this token belongs to: discovered, or the admin's id verified by the token. */
export async function resolveAccount(cf: CfTransport, typedAccountId: string | undefined): Promise<{ ok: true; id: string } | { ok: false; reason: "none" | "several" | "unverified" }> {
  if (typedAccountId) {
    try {
      await accounts.verifyToken(cf, typedAccountId);
      return { ok: true, id: typedAccountId };
    } catch {
      return { ok: false, reason: "unverified" };
    }
  }
  const list = await accounts.list(cf).catch(() => []);
  if (list.length === 1) return { ok: true, id: list[0]!.id };
  return { ok: false, reason: list.length === 0 ? "none" : "several" };
}
