/**
 * Wizard step 7: identity providers teammates can sign in with.
 *
 * A fresh Zero Trust org admits only Cloudflare account members (`type: cloudflare`), so
 * the step lists the IdPs, explains that, and offers One-time PIN in one click or a GitHub
 * or Google form (client id and secret, with the callback URL to register). The step can
 * finish only once at least one non-Cloudflare IdP exists (gate G10 verifies the shapes).
 */
import type { CfTransport } from "../../admin/ports.ts";
import { idp, type CfIdp } from "../../cloudflare/setup-endpoints.ts";
import type { SetupEvent } from "../wizard-state.ts";

export type IdpKind = "onetimepin" | "github" | "google";

export const IDP_SETUP_LINKS: Record<Exclude<IdpKind, "onetimepin">, string> = {
  github: "https://github.com/settings/applications/new",
  google: "https://console.cloud.google.com/apis/credentials",
};

export function callbackUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/callback`;
}

export function usableIdps(list: readonly CfIdp[]): CfIdp[] {
  return list.filter((p) => p.type !== "cloudflare");
}

export function listIdps(cf: CfTransport, accountId: string): Promise<CfIdp[]> {
  return idp.list(cf, accountId);
}

export type AddIdpOutcome = { ok: true } | { ok: false; problem: "client_fields_required" };

/** Adds an IdP unless one of that type already exists (idempotent re-run). */
export async function addIdp(cf: CfTransport, accountId: string, kind: IdpKind, clientId = "", clientSecret = ""): Promise<AddIdpOutcome> {
  if ((await idp.list(cf, accountId)).some((p) => p.type === kind)) return { ok: true };
  if (kind === "onetimepin") {
    await idp.create(cf, accountId, { name: "One-time PIN", type: "onetimepin", config: {} });
    return { ok: true };
  }
  if (!clientId.trim() || !clientSecret.trim()) return { ok: false, problem: "client_fields_required" };
  await idp.create(cf, accountId, {
    name: kind === "github" ? "GitHub" : "Google",
    type: kind,
    config: { client_id: clientId.trim(), client_secret: clientSecret.trim() },
  });
  return { ok: true };
}

export async function finishIdp(cf: CfTransport, accountId: string): Promise<{ ok: true; event: SetupEvent } | { ok: false; problem: "no_usable_idp" }> {
  const usable = usableIdps(await idp.list(cf, accountId));
  if (usable.length === 0) return { ok: false, problem: "no_usable_idp" };
  return { ok: true, event: { kind: "idp_ready", idp_ids: usable.map((p) => p.id) } };
}
