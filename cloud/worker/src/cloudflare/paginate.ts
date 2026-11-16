/**
 * Page-based listing for Cloudflare list endpoints, with a `maxPages` guard.
 *
 * Every list endpoint the engine uses is page-based (no cursors). `listAll` walks pages until
 * `total_count` items are in hand, the last page is reached, or a page comes back short, and
 * refuses to walk past `maxPages` so a lying `total_count` cannot burn the API budget.
 *
 * - Returns the server's `total_count` (the quota guard reads it from `per_page=1` lists).
 * - `maxPages: 1` asks for the first page only (exact-name lookups, totals) and never throws.
 *
 * <module-headers:begin>
 * Uses:
 * src/cloudflare/paginate.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * └── src/cloudflare/errors.ts
 * External: none
 *
 * Used by:
 * src/cloudflare/paginate.ts
 * ├── src/cloudflare/access.ts
 * ├── src/cloudflare/dns.ts
 * ├── src/cloudflare/tunnels.ts
 * └── test/provisioning/paginate.test.ts
 * <module-headers:end>
 */
import type { Priority } from "./budget.ts";
import { CfApiError } from "./errors.ts";
import type { CfClient } from "./client.ts";

export interface ListOptions {
  priority: Priority;
  query?: Record<string, string | number | boolean | undefined>;
  perPage: number;
  maxPages: number;
}

export interface ListResult<T> {
  items: T[];
  total: number;
}

export async function listAll<T>(cf: CfClient, path: string, o: ListOptions): Promise<ListResult<T>> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    if (page > o.maxPages) {
      throw new CfApiError("invalid", null, `GET ${path}`, [], null, `GET ${path} needs more than ${o.maxPages} pages; refusing to list further`);
    }
    const env = await cf.request<T[]>("GET", path, {
      priority: o.priority,
      query: { ...o.query, page, per_page: o.perPage },
    });
    const pageItems = Array.isArray(env.result) ? env.result : [];
    items.push(...pageItems);
    const info = env.result_info ?? {};
    const total = info.total_count ?? items.length;
    const lastPage = info.total_pages !== undefined && page >= info.total_pages;
    if (o.maxPages === 1 || pageItems.length < o.perPage || items.length >= total || lastPage) return { items, total };
  }
}
