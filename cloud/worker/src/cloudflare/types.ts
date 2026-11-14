/**
 * Minimal response subsets of the Cloudflare endpoints the engine calls.
 *
 * Each interface names only the fields the Worker reads, so an added server field never
 * breaks parsing and a removed one shows up in the fixture contract test. Field names follow
 * Cloudflare's OpenAPI schema (`cloudflare/api-schemas`, commit 2026-11-13).
 *
 * - `TunnelRes.token` is absent from the schema but present in practice (R4 §1.1, §1.8);
 *   callers fall back to `GET …/token`.
 * - `connections` was removed from tunnel list/get on 2026-10-05 and is not read.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * src/cloudflare/types.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/desired.ts
 * ├── src/cloudflare/dns.ts
 * └── src/cloudflare/tunnels.ts
 * <module-headers:end>
 */

export type TunnelStatus = "inactive" | "degraded" | "healthy" | "down";

export interface TunnelRes {
  id: string;
  name: string;
  status?: TunnelStatus;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  token?: string;
}

export interface IngressRule {
  hostname?: string;
  service: string;
  originRequest?: Record<string, unknown>;
}

export interface TunnelConfig {
  ingress: IngressRule[];
  originRequest?: Record<string, unknown>;
}

export interface TunnelConfigRes {
  version?: number;
  config?: TunnelConfig | null;
}

export interface DnsRecordRes {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
}

export interface AccessAppRes {
  id: string;
  aud: string;
  name: string;
  domain: string;
  type?: string;
  destinations?: Array<{ type: string; uri?: string }>;
  session_duration?: string;
  app_launcher_visible?: boolean;
  enable_binding_cookie?: boolean;
  http_only_cookie_attribute?: boolean;
  same_site_cookie_attribute?: string;
  options_preflight_bypass?: boolean;
  allow_iframe?: boolean;
  policies?: Array<{ id: string; precedence?: number }>;
  oauth_configuration?: unknown;
}

export interface AccessPolicyRes {
  id: string;
  name: string;
  decision: string;
  include: unknown[];
  app_count?: number;
}
