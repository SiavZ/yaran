/**
 * Cloudflare Access endpoints: self-hosted applications and reusable policies.
 *
 * Typed wrappers over `/accounts/{a}/access/apps` and `/accounts/{a}/access/policies`.
 *
 * - Apps have no PATCH: `replaceApp` PUTs the whole desired object.
 * - Policies list with `page`/`per_page` only (no name filter); the account holds at most
 *   500, so one `per_page=1000` page covers it.
 * - A policy must be detached from every app before it can be deleted.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/access.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/paginate.ts
 * └── src/cloudflare/types.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/access.ts
 * ├── src/provisioning/quota.ts
 * ├── src/provisioning/steps-provision.ts
 * ├── src/provisioning/steps-teardown.ts
 * ├── src/reconcile/drift.ts
 * ├── src/reconcile/orphans.ts
 * ├── test/provisioning/endpoints.test.ts
 * └── test/provisioning/fixture-contract.test.ts
 * <module-headers:end>
 */
import type { Priority } from "./budget.ts";
import type { CfClient } from "./client.ts";
import { listAll, type ListResult } from "./paginate.ts";
import type { AccessAppRes, AccessPolicyRes } from "./types.ts";

const apps = (account: string) => `/accounts/${encodeURIComponent(account)}/access/apps`;
const policies = (account: string) => `/accounts/${encodeURIComponent(account)}/access/policies`;

/** Apps whose domain is exactly `domain`. */
export async function findAppsByDomain(cf: CfClient, account: string, domain: string, priority: Priority): Promise<AccessAppRes[]> {
  const { items } = await listAll<AccessAppRes>(cf, apps(account), { priority, perPage: 50, maxPages: 1, query: { domain, exact: true } });
  return items;
}

export function listApps(cf: CfClient, account: string, priority: Priority, perPage = 1000): Promise<ListResult<AccessAppRes>> {
  return listAll<AccessAppRes>(cf, apps(account), { priority, perPage, maxPages: perPage === 1 ? 1 : 2 });
}

export function getApp(cf: CfClient, account: string, id: string, priority: Priority): Promise<AccessAppRes> {
  return cf.request<AccessAppRes>("GET", `${apps(account)}/${encodeURIComponent(id)}`, { priority }).then((e) => e.result);
}

export function createApp(cf: CfClient, account: string, body: object, priority: Priority): Promise<AccessAppRes> {
  return cf.request<AccessAppRes>("POST", apps(account), { priority, body }).then((e) => e.result);
}

export function replaceApp(cf: CfClient, account: string, id: string, body: object, priority: Priority): Promise<AccessAppRes> {
  return cf.request<AccessAppRes>("PUT", `${apps(account)}/${encodeURIComponent(id)}`, { priority, body }).then((e) => e.result);
}

export async function deleteApp(cf: CfClient, account: string, id: string, priority: Priority): Promise<void> {
  await cf.request<unknown>("DELETE", `${apps(account)}/${encodeURIComponent(id)}`, { priority });
}

export function listPolicies(cf: CfClient, account: string, priority: Priority, perPage = 1000): Promise<ListResult<AccessPolicyRes>> {
  return listAll<AccessPolicyRes>(cf, policies(account), { priority, perPage, maxPages: perPage === 1 ? 1 : 2 });
}

export function getPolicy(cf: CfClient, account: string, id: string, priority: Priority): Promise<AccessPolicyRes> {
  return cf.request<AccessPolicyRes>("GET", `${policies(account)}/${encodeURIComponent(id)}`, { priority }).then((e) => e.result);
}

export function createPolicy(cf: CfClient, account: string, body: object, priority: Priority): Promise<AccessPolicyRes> {
  return cf.request<AccessPolicyRes>("POST", policies(account), { priority, body }).then((e) => e.result);
}

export function replacePolicy(cf: CfClient, account: string, id: string, body: object, priority: Priority): Promise<AccessPolicyRes> {
  return cf.request<AccessPolicyRes>("PUT", `${policies(account)}/${encodeURIComponent(id)}`, { priority, body }).then((e) => e.result);
}

export async function deletePolicy(cf: CfClient, account: string, id: string, priority: Priority): Promise<void> {
  await cf.request<unknown>("DELETE", `${policies(account)}/${encodeURIComponent(id)}`, { priority });
}
