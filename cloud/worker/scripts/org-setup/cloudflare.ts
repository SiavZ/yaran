/**
 * The org installer's Cloudflare API calls, over the same `CfTransport` port the Worker's
 * setup steps use, so the installer can run the Worker's own capability probe and zone
 * checks before it writes anything.
 *
 * Two tokens go through it, never logged and never in a URL: the deployer's Wrangler login
 * (Workers, D1, Queues, zone read) for the resources the deploy needs, and, when the
 * deployer supplies one, the control plane's runtime API token for the read-only probe.
 * Cloudflare's error text is untrusted: it is stripped of control characters, cut short,
 * and any secret this request carried (the token, a body value) is redacted from it.
 *
 * <module-headers:begin>
 * Uses:
 * scripts/org-setup/cloudflare.ts
 * ├── src/admin/ports.ts
 * ├── src/cloudflare/errors.ts
 * └── src/security/sanitize.ts
 * External: none
 *
 * Used by:
 * scripts/org-setup/cloudflare.ts
 * └── scripts/org-setup/run.ts
 * <module-headers:end>
 */
import type { CfTransport } from "../../src/admin/ports.ts";
import { CfApiError, classify, type CfErrorItem } from "../../src/cloudflare/errors.ts";
import { truncate } from "../../src/security/sanitize.ts";

const API = "https://api.cloudflare.com/client/v4";

/** Upstream error text made safe to print: no control characters, no secret this request carried. */
export function scrubbed(message: string, secrets: string[]): string {
  let out = message;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted]");
  return truncate(out, 200);
}

export function cfTransport(fetchFn: typeof fetch, token: string): CfTransport {
  return {
    async request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
      const endpoint = `${method} ${path.split("?")[0]}`;
      let res: Response;
      try {
        res = await fetchFn(API + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new CfApiError("transient", null, endpoint);
      }
      const env = (await res.json().catch(() => ({}))) as { success?: boolean; errors?: CfErrorItem[]; result?: T };
      if (!res.ok || env.success === false) {
        const errors = env.errors ?? [];
        const secrets = [token, ...Object.values(body ?? {}).filter((v): v is string => typeof v === "string")];
        const detail = errors[0] ? `: ${scrubbed(String(errors[0].message), secrets)}` : "";
        throw new CfApiError(classify(res.status, errors), res.status, endpoint, errors, null, `${endpoint} failed (HTTP ${res.status}${detail})`);
      }
      return env.result as T;
    },
  };
}

const acct = (id: string) => `/accounts/${encodeURIComponent(id)}`;
const q = encodeURIComponent;

export interface ScriptBinding {
  type: string;
  name: string;
  id?: string;
  database_id?: string;
  queue_name?: string;
  text?: string;
}

export interface SetupRecord {
  step: string;
  cp_host?: string;
  admin_email?: string;
}

/** What the installer reads and writes with the deployer's own Wrangler login. */
export const account = {
  workersSubdomain: (cf: CfTransport, a: string) => cf.request<{ subdomain: string }>("GET", `${acct(a)}/workers/subdomain`),
  /** The Worker's bindings (secrets by name only), or null when no such Worker exists. */
  async scriptBindings(cf: CfTransport, a: string, script: string): Promise<ScriptBinding[] | null> {
    try {
      return (await cf.request<{ bindings?: ScriptBinding[] }>("GET", `${acct(a)}/workers/scripts/${q(script)}/settings`)).bindings ?? [];
    } catch (e) {
      if (e instanceof CfApiError && e.kind === "not_found") return null;
      throw e;
    }
  },
  /** The known Worker's secret names; any failed read stops the run. */
  async secretNames(cf: CfTransport, a: string, script: string): Promise<Set<string>> {
    return new Set((await cf.request<{ name: string }[]>("GET", `${acct(a)}/workers/scripts/${q(script)}/secrets`)).map((x) => x.name));
  },
  putSecret: (cf: CfTransport, a: string, script: string, name: string, text: string) =>
    cf.request<unknown>("PUT", `${acct(a)}/workers/scripts/${q(script)}/secrets`, { name, text, type: "secret_text" }),
  findDatabase: async (cf: CfTransport, a: string, name: string) =>
    (await cf.request<{ uuid: string; name: string }[]>("GET", `${acct(a)}/d1/database?name=${q(name)}`)).find((d) => d.name === name) ?? null,
  getDatabase: (cf: CfTransport, a: string, id: string) => cf.request<{ uuid: string; name: string }>("GET", `${acct(a)}/d1/database/${q(id)}`),
  createDatabase: (cf: CfTransport, a: string, name: string) => cf.request<{ uuid: string; name: string }>("POST", `${acct(a)}/d1/database`, { name }),
  /** The persisted wizard record, or null on a database whose migrations never ran. */
  async setupRecord(cf: CfTransport, a: string, dbId: string): Promise<SetupRecord | null> {
    let value: string | undefined;
    try {
      const out = await cf.request<{ results: { value: string }[] }[]>("POST", `${acct(a)}/d1/database/${q(dbId)}/query`, {
        sql: "SELECT value FROM settings WHERE key = ?",
        params: ["setup_wizard"],
      });
      value = out[0]?.results[0]?.value;
    } catch (e) {
      if (e instanceof CfApiError && e.cfErrors.some((x) => /no such table/i.test(x.message))) return null;
      throw e;
    }
    if (!value) return null;
    try {
      return JSON.parse(value) as SetupRecord;
    } catch {
      throw new Error("The control plane's setup record is not valid JSON; open its /setup page to see its state.");
    }
  },
  async queueExists(cf: CfTransport, a: string, name: string): Promise<boolean> {
    for (let page = 1; page <= 20; page++) {
      const list = await cf.request<{ queue_name: string }[]>("GET", `${acct(a)}/queues?page=${page}&per_page=100`);
      if (list.some((x) => x.queue_name === name)) return true;
      if (list.length < 100) return false;
    }
    return false;
  },
  createQueue: (cf: CfTransport, a: string, name: string) => cf.request<unknown>("POST", `${acct(a)}/queues`, { queue_name: name }),
  findZone: async (cf: CfTransport, a: string, name: string) =>
    (await cf.request<{ id: string; name: string }[]>("GET", `/zones?name=${q(name)}&account.id=${q(a)}`)).find((z) => z.name === name) ?? null,
};
