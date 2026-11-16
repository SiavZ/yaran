/**
 * Cloudflare Tunnel endpoints (remotely managed tunnels, `config_src: "cloudflare"`).
 *
 * Typed wrappers over `/accounts/{a}/cfd_tunnel`: create, get, list, find by name, secret
 * rotation, token fetch, ingress configuration, connection eviction and delete.
 *
 * - The token is returned to the caller and never stored or logged here.
 * - `rotateSecret` and `create` read `result.token` when present and otherwise fall back to
 *   `GET …/token` (the schema omits it; R4 §1.1, §1.8).
 * - `cascade` is never used: it is undocumented in the API reference.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/tunnels.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/paginate.ts
 * └── src/cloudflare/types.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/tunnels.ts
 * ├── src/provisioning/index.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-rotate.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/orphans.ts
 * ├── src/reconcile/status.ts
 * ├── test/provisioning/endpoints.test.ts
 * └── test/provisioning/fixture-contract.test.ts
 * <module-headers:end>
 */
import type { Priority } from "./budget.ts";
import type { CfClient } from "./client.ts";
import { listAll } from "./paginate.ts";
import type { TunnelConfig, TunnelConfigRes, TunnelRes } from "./types.ts";

const base = (account: string) => `/accounts/${encodeURIComponent(account)}/cfd_tunnel`;
const one = (account: string, id: string) => `${base(account)}/${encodeURIComponent(id)}`;

export function createTunnel(cf: CfClient, account: string, name: string, priority: Priority): Promise<TunnelRes> {
  return cf.request<TunnelRes>("POST", base(account), { priority, body: { name, config_src: "cloudflare" } }).then((e) => e.result);
}

export function getTunnel(cf: CfClient, account: string, id: string, priority: Priority): Promise<TunnelRes> {
  return cf.request<TunnelRes>("GET", one(account, id), { priority }).then((e) => e.result);
}

export interface TunnelListFilter {
  name?: string;
  include_prefix?: string;
  per_page: number;
  maxPages: number;
}

/** Live (not deleted) tunnels matching the filter, plus the server's total. */
export function listTunnels(cf: CfClient, account: string, f: TunnelListFilter, priority: Priority) {
  return listAll<TunnelRes>(cf, base(account), {
    priority,
    perPage: f.per_page,
    maxPages: f.maxPages,
    query: { name: f.name, include_prefix: f.include_prefix, is_deleted: false },
  });
}

export async function findTunnelByName(cf: CfClient, account: string, name: string, priority: Priority): Promise<TunnelRes | null> {
  const { items } = await listTunnels(cf, account, { name, per_page: 50, maxPages: 1 }, priority);
  return items.find((t) => t.name === name && !t.deleted_at) ?? null;
}

export function getTunnelToken(cf: CfClient, account: string, id: string, priority: Priority): Promise<string> {
  return cf.request<string>("GET", `${one(account, id)}/token`, { priority }).then((e) => e.result);
}

/** Replaces the tunnel secret: the old token can no longer open connections. */
export function patchTunnelSecret(cf: CfClient, account: string, id: string, secret: string, priority: Priority): Promise<TunnelRes> {
  return cf.request<TunnelRes>("PATCH", one(account, id), { priority, body: { tunnel_secret: secret } }).then((e) => e.result);
}

/** Rotates the tunnel secret; returns the new token (from the response or a follow-up GET). */
export async function rotateTunnelSecret(cf: CfClient, account: string, id: string, secret: string, priority: Priority): Promise<string> {
  const res = await patchTunnelSecret(cf, account, id, secret, priority);
  if (typeof res?.token === "string" && res.token !== "") return res.token;
  return getTunnelToken(cf, account, id, priority);
}

/** Replaces the whole ingress configuration; returns the new `version`. */
export async function putTunnelConfig(cf: CfClient, account: string, id: string, config: TunnelConfig, priority: Priority): Promise<number | null> {
  const res = await cf.request<TunnelConfigRes>("PUT", `${one(account, id)}/configurations`, { priority, body: { config } });
  return res.result?.version ?? null;
}

export function getTunnelConfig(cf: CfClient, account: string, id: string, priority: Priority): Promise<TunnelConfigRes> {
  return cf.request<TunnelConfigRes>("GET", `${one(account, id)}/configurations`, { priority }).then((e) => e.result);
}

export async function deleteTunnelConnections(cf: CfClient, account: string, id: string, priority: Priority): Promise<void> {
  await cf.request<unknown>("DELETE", `${one(account, id)}/connections`, { priority });
}

export async function deleteTunnel(cf: CfClient, account: string, id: string, priority: Priority): Promise<void> {
  await cf.request<unknown>("DELETE", one(account, id), { priority });
}

/** 32 random bytes, base64: the value a secret rotation or invalidation sends. */
export function randomTunnelSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
