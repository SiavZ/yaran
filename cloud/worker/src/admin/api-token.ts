/**
 * The Cloudflare API token's one home: sealed in D1, replaced only after a passing probe.
 *
 * The wizard stores the token it probed (from the `CF_API_TOKEN` secret or pasted), after
 * which the Worker secret may be deleted. The Health page's Replace API token runs the same
 * capability probe on the new token before it overwrites the old one.
 *
 * - Sealed with 04's DATA_KEY helper under purpose `cf_api_token`; never rendered or logged.
 *
 * <module-headers:begin>
 * Uses:
 * src/admin/api-token.ts
 * ├── src/admin/ports.ts
 * ├── src/admin/settings-store.ts
 * ├── src/admin/setup-settings.ts
 * ├── src/console/route-types.ts
 * └── src/setup/capability-probe.ts
 * External: none
 *
 * Used by:
 * src/admin/api-token.ts
 * ├── src/admin/health.ts
 * ├── src/admin/settings-apply.ts
 * ├── src/console/admin-routes.ts
 * └── src/setup/routes.ts
 * <module-headers:end>
 */
import type { CfTransport } from "./ports.ts";
import type { Phase07Deps } from "../console/route-types.ts";
import { readKey, writeKeys } from "./settings-store.ts";
import { probeCapabilities, probePassed, type ProbeRow } from "../setup/capability-probe.ts";

import { API_TOKEN_AAD as AAD, API_TOKEN_KEY as KEY } from "./setup-settings.ts";

export async function storeToken(deps: Phase07Deps, token: string, actor: string): Promise<void> {
  await writeKeys(deps.db, { [KEY]: await deps.sealer.seal("cf_api_token", AAD, token) }, actor, deps.now());
}

/** The stored token, or the deploy-time secret before the wizard has stored one. */
export async function currentToken(deps: Phase07Deps): Promise<string | undefined> {
  const sealed = await readKey<string>(deps.db, KEY);
  if (sealed) return deps.sealer.open("cf_api_token", AAD, sealed);
  return deps.env.CF_API_TOKEN || undefined;
}

export async function storedCf(deps: Phase07Deps): Promise<CfTransport> {
  const token = await currentToken(deps);
  if (!token) throw new Error("no Cloudflare API token is stored; finish the setup token step first");
  return deps.cfFor(token);
}

/** Probes a replacement token and stores it only when every permission passes. */
export async function replaceToken(deps: Phase07Deps, token: string, accountId: string, scriptName: string, actor: string): Promise<{ stored: boolean; rows: ProbeRow[] }> {
  const rows = await probeCapabilities(deps.cfFor(token), accountId, scriptName);
  if (!probePassed(rows)) return { stored: false, rows };
  await storeToken(deps, token, actor);
  await deps.audit({ actor: { kind: "admin", id: actor }, action: "settings.updated", target: { kind: "settings" }, outcome: "ok", detail: { changed: ["cf_api_token"] } });
  return { stored: true, rows };
}
