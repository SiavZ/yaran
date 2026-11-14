/**
 * Cloudflare API transport: base URL, bearer auth, 10 s timeout, envelope parsing, in-call
 * retries for idempotent verbs, and the budget gate before every network call.
 *
 * Every Cloudflare call the Worker makes goes through `CfClient.request`, so the budget,
 * error classification and token handling cannot be bypassed by an endpoint module.
 *
 * - The base URL is `CF_API_BASE_URL` (Phase 19 hook H3: staging's chaos proxy) or the
 *   public API; anything but `https:` is refused so the token never travels in clear.
 * - GET, PUT and DELETE retry `transient` failures twice with full jitter (200-1,500 ms);
 *   POST and PATCH never retry here, the saga's adopt step makes them safe.
 * - The token lives only in the request header; errors and logs never carry it.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/client.ts
 * ├── src/cloudflare/budget.ts
 * └── src/cloudflare/errors.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/client.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/paginate.ts
 * ├── src/cloudflare/tunnels.ts
 * ├── src/provisioning/ports.ts
 * ├── test/provisioning/budget.test.ts
 * ├── test/provisioning/client.test.ts
 * ├── test/provisioning/helpers/world.ts
 * └── test/provisioning/paginate.test.ts
 * <module-headers:end>
 */
import { ApiBudget, DEFAULT_BLOCK_SECONDS, type Priority } from "./budget.ts";
import { CfApiError, classify, type CfErrorItem } from "./errors.ts";

export const DEFAULT_CF_API_BASE_URL = "https://api.cloudflare.com/client/v4";
export const CF_TIMEOUT_MS = 10_000;
const RETRIES = 2;
const JITTER_MIN_MS = 200;
const JITTER_MAX_MS = 1_500;

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ResultInfo {
  page?: number;
  per_page?: number;
  count?: number;
  total_count?: number;
  total_pages?: number;
}

export interface Envelope<T> {
  success: boolean;
  errors: CfErrorItem[];
  result: T;
  result_info?: ResultInfo;
}

/** Validates `CF_API_BASE_URL`; throws a message naming the variable (never a secret). */
export function resolveCfBaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === "") return DEFAULT_CF_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CF_API_BASE_URL is not a valid URL; refusing to call the Cloudflare API");
  }
  if (url.protocol !== "https:") {
    throw new Error("CF_API_BASE_URL must use https:; refusing to send the API token in clear");
  }
  return raw.replace(/\/+$/, "");
}

export interface CfClientOptions {
  fetch: typeof fetch;
  token: string;
  baseUrl: string;
  budget: ApiBudget;
  userAgent: string;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  timeoutMs?: number;
}

export interface RequestOptions {
  priority: Priority;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class CfClient {
  /** Network calls made (attempts, retries included); drives the per-run caps. */
  calls = 0;
  readonly budget: ApiBudget;

  constructor(private readonly opts: CfClientOptions) {
    this.budget = opts.budget;
  }

  async request<T>(method: HttpMethod, path: string, o: RequestOptions): Promise<Envelope<T>> {
    const endpoint = `${method} ${path}`;
    const idempotent = method === "GET" || method === "PUT" || method === "DELETE";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, endpoint, o);
      } catch (err) {
        if (!(err instanceof CfApiError) || err.kind !== "transient" || !idempotent || attempt >= RETRIES) throw err;
        const rnd = (this.opts.random ?? Math.random)();
        await this.opts.sleep(JITTER_MIN_MS + Math.floor(rnd * (JITTER_MAX_MS - JITTER_MIN_MS)));
      }
    }
  }

  private async once<T>(method: HttpMethod, path: string, endpoint: string, o: RequestOptions): Promise<Envelope<T>> {
    await this.budget.gate(o.priority, endpoint);
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.token}`,
      "user-agent": this.opts.userAgent,
      accept: "application/json",
    };
    if (o.body !== undefined) headers["content-type"] = "application/json";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? CF_TIMEOUT_MS);
    this.calls++;
    let res: Response;
    let text: string;
    try {
      const init: RequestInit = { method, headers, signal: ac.signal };
      if (o.body !== undefined) init.body = JSON.stringify(o.body);
      res = await this.opts.fetch(url.toString(), init);
      text = await res.text();
    } catch {
      throw new CfApiError("transient", null, endpoint, [], null, `${endpoint} failed: network error or timeout`);
    } finally {
      clearTimeout(timer);
    }
    this.budget.observe(res.headers, res.status);
    let env: Envelope<T> | null = null;
    try {
      env = JSON.parse(text) as Envelope<T>;
    } catch {
      env = null;
    }
    if (res.status === 429) {
      throw new CfApiError("rate_limited", 429, endpoint, env?.errors ?? [], this.retryAfter(res));
    }
    if (env === null || typeof env !== "object") {
      throw new CfApiError(res.ok ? "transient" : classify(res.status, []), res.status, endpoint, [], null, `${endpoint} answered HTTP ${res.status} with a non-JSON body`);
    }
    const errors = Array.isArray(env.errors) ? env.errors : [];
    if (!res.ok || env.success === false) {
      throw new CfApiError(classify(res.ok ? 400 : res.status, errors), res.status, endpoint, errors);
    }
    return { ...env, errors };
  }

  private retryAfter(res: Response): number {
    const ra = Number(res.headers.get("retry-after"));
    return Number.isFinite(ra) && ra > 0 ? ra : DEFAULT_BLOCK_SECONDS;
  }
}
