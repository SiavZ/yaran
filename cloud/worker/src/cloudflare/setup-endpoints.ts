/**
 * Cloudflare API operations the setup wizard and the admin console add to 05's client.
 *
 * Typed functions over 05's transport (budget, retries and error mapping live there), each
 * declaring only the response fields it reads: accounts and token verify, the Zero Trust
 * organization, zones and DNS lookups, Worker custom domains, the workers.dev subdomain,
 * script settings, the control-plane Access app and the reusable policy, identity
 * providers and Access groups.
 *
 * - No retries or idempotency here: callers look up by name before creating.
 * - Response shapes marked UNVERIFIED are recorded by gates G8, G10 and G14.
 */
import type { CfTransport } from "../admin/ports.ts";

export interface CfAccount { id: string; name: string }
export interface CfZone { id: string; name: string }
export interface CfOrg { auth_domain: string; name?: string }
export interface CfWorkerDomain { id: string; hostname: string; service: string; zone_id: string }
export interface CfIdp { id: string; name: string; type: string }
export interface CfGroup { id: string; name: string }
export interface CfPolicy { id: string; name: string; decision: string; include: unknown[] }
export interface CfAccessApp {
  id: string;
  name: string;
  domain: string;
  aud: string;
  type?: string;
  destinations?: { type: string; uri: string; overrides?: { behavior: string; path_pattern: string }[] }[];
  policies?: { id: string }[];
}

const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;
const q = encodeURIComponent;

export const accounts = {
  list: (cf: CfTransport) => cf.request<CfAccount[]>("GET", "/accounts?per_page=50"),
  verifyToken: (cf: CfTransport, accountId: string) => cf.request<{ status: string }>("GET", `${acct(accountId)}/tokens/verify`),
};

export const org = {
  get: (cf: CfTransport, accountId: string) => cf.request<CfOrg>("GET", `${acct(accountId)}/access/organizations`),
  /** G10: creating the organization by API; UNVERIFIED whether a fresh account may. */
  create: (cf: CfTransport, accountId: string, name: string, authDomain: string) =>
    cf.request<CfOrg>("POST", `${acct(accountId)}/access/organizations`, { name, auth_domain: authDomain }),
};

export const zones = {
  list: (cf: CfTransport) => cf.request<CfZone[]>("GET", "/zones?per_page=50"),
  findDnsRecord: (cf: CfTransport, zoneId: string, name: string) =>
    cf.request<{ id: string }[]>("GET", `/zones/${q(zoneId)}/dns_records?name=${q(name)}`),
  probeDns: (cf: CfTransport, zoneId: string) => cf.request<unknown[]>("GET", `/zones/${q(zoneId)}/dns_records?per_page=1`),
};

export const workers = {
  listDomains: (cf: CfTransport, accountId: string, hostname: string) =>
    cf.request<CfWorkerDomain[]>("GET", `${acct(accountId)}/workers/domains?hostname=${q(hostname)}`),
  attachDomain: (cf: CfTransport, accountId: string, body: { hostname: string; service: string; zone_id: string }) =>
    cf.request<CfWorkerDomain>("PUT", `${acct(accountId)}/workers/domains`, body),
  setSubdomain: (cf: CfTransport, accountId: string, script: string, enabled: boolean) =>
    cf.request<{ enabled: boolean }>("POST", `${acct(accountId)}/workers/scripts/${q(script)}/subdomain`, { enabled, previews_enabled: enabled }),
  getSubdomain: (cf: CfTransport, accountId: string, script: string) =>
    cf.request<{ enabled: boolean }>("GET", `${acct(accountId)}/workers/scripts/${q(script)}/subdomain`),
  /** Shape UNVERIFIED (G14); only success matters, as proof the script name is right. */
  getScriptSettings: (cf: CfTransport, accountId: string, script: string) =>
    cf.request<unknown>("GET", `${acct(accountId)}/workers/scripts/${q(script)}/settings`),
};

export const tunnels = {
  probe: (cf: CfTransport, accountId: string) => cf.request<unknown[]>("GET", `${acct(accountId)}/cfd_tunnel?per_page=1&is_deleted=false`),
};

export const access = {
  listApps: (cf: CfTransport, accountId: string) => cf.request<CfAccessApp[]>("GET", `${acct(accountId)}/access/apps`),
  createApp: (cf: CfTransport, accountId: string, body: Record<string, unknown>) => cf.request<CfAccessApp>("POST", `${acct(accountId)}/access/apps`, body),
  updateApp: (cf: CfTransport, accountId: string, appId: string, body: Record<string, unknown>) =>
    cf.request<CfAccessApp>("PUT", `${acct(accountId)}/access/apps/${q(appId)}`, body),
  listPolicies: (cf: CfTransport, accountId: string) => cf.request<CfPolicy[]>("GET", `${acct(accountId)}/access/policies`),
  createPolicy: (cf: CfTransport, accountId: string, body: Record<string, unknown>) => cf.request<CfPolicy>("POST", `${acct(accountId)}/access/policies`, body),
  updatePolicy: (cf: CfTransport, accountId: string, policyId: string, body: Record<string, unknown>) =>
    cf.request<CfPolicy>("PUT", `${acct(accountId)}/access/policies/${q(policyId)}`, body),
  listGroups: (cf: CfTransport, accountId: string) => cf.request<CfGroup[]>("GET", `${acct(accountId)}/access/groups`),
};

export const idp = {
  list: (cf: CfTransport, accountId: string) => cf.request<CfIdp[]>("GET", `${acct(accountId)}/access/identity_providers`),
  create: (cf: CfTransport, accountId: string, body: { name: string; type: string; config: Record<string, string> }) =>
    cf.request<CfIdp>("POST", `${acct(accountId)}/access/identity_providers`, body),
};
