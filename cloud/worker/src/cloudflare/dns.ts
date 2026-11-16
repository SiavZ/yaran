/**
 * Cloudflare DNS record endpoints for the zone the machine hostnames live in.
 *
 * Typed wrappers over `/zones/{z}/dns_records`: find by name, list by comment prefix (the
 * instance marker), get, create, patch and delete.
 *
 * - `name` filters are exact and case-insensitive; comments are at most 100 characters on
 *   Free, which the 53-character marker respects; tags are not available on Free.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/dns.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/paginate.ts
 * └── src/cloudflare/types.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/dns.ts
 * ├── src/cloudflare/desired.ts
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
import { listAll } from "./paginate.ts";
import type { DnsRecordRes } from "./types.ts";

const base = (zone: string) => `/zones/${encodeURIComponent(zone)}/dns_records`;
const one = (zone: string, id: string) => `${base(zone)}/${encodeURIComponent(id)}`;

export interface DnsRecordBody {
  type: "CNAME";
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment: string;
}

/** Every record at `name` (all types, unless `type` is given). */
export async function findDnsByName(cf: CfClient, zone: string, name: string, priority: Priority, type?: string): Promise<DnsRecordRes[]> {
  const { items } = await listAll<DnsRecordRes>(cf, base(zone), { priority, perPage: 100, maxPages: 1, query: { name, type } });
  return items;
}

export function listDnsByCommentPrefix(cf: CfClient, zone: string, prefix: string, priority: Priority) {
  return listAll<DnsRecordRes>(cf, base(zone), { priority, perPage: 1000, maxPages: 5, query: { "comment.startswith": prefix } });
}

export function getDnsRecord(cf: CfClient, zone: string, id: string, priority: Priority): Promise<DnsRecordRes> {
  return cf.request<DnsRecordRes>("GET", one(zone, id), { priority }).then((e) => e.result);
}

export function createDnsRecord(cf: CfClient, zone: string, body: DnsRecordBody, priority: Priority): Promise<DnsRecordRes> {
  return cf.request<DnsRecordRes>("POST", base(zone), { priority, body }).then((e) => e.result);
}

export function patchDnsRecord(cf: CfClient, zone: string, id: string, body: Partial<DnsRecordBody>, priority: Priority): Promise<DnsRecordRes> {
  return cf.request<DnsRecordRes>("PATCH", one(zone, id), { priority, body }).then((e) => e.result);
}

export async function deleteDnsRecord(cf: CfClient, zone: string, id: string, priority: Priority): Promise<void> {
  await cf.request<unknown>("DELETE", one(zone, id), { priority });
}
