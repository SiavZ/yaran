/**
 * Page-based listing and the maxPages guard.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/paginate.test.ts
 * ├── src/cloudflare/budget.ts
 * ├── src/cloudflare/client.ts
 * ├── src/cloudflare/paginate.ts
 * └── test/provisioning/helpers/d1.ts
 * External: vitest
 *
 * Used by: entry point (vitest, via npm test in cloud/worker (workerd, or Node for test/provisioning))
 * <module-headers:end>
 */
import { describe, expect, it } from "vitest";
import { ApiBudget } from "../../src/cloudflare/budget.ts";
import { CfClient } from "../../src/cloudflare/client.ts";
import { listAll } from "../../src/cloudflare/paginate.ts";
import { FakeD1 } from "./helpers/d1.ts";

function pages(total: number, lie = false) {
  const c = new CfClient({
    fetch: (async (u: RequestInfo | URL) => {
      const q = new URL(String(u)).searchParams;
      const page = Number(q.get("page"));
      const per = Number(q.get("per_page"));
      const items = Array.from({ length: total }, (_, i) => i).slice((page - 1) * per, page * per);
      return Response.json({ success: true, errors: [], result: lie ? Array(per).fill(0) : items, result_info: { page, per_page: per, total_count: lie ? 1e6 : total } });
    }) as typeof fetch,
    token: "t",
    baseUrl: "https://api.cloudflare.com/client/v4",
    budget: new ApiBudget(new FakeD1(), () => 0),
    userAgent: "t",
    sleep: async () => {},
  });
  return c;
}

describe("listAll", () => {
  it("walks pages until total_count", async () => {
    const c = pages(25);
    const r = await listAll<number>(c, "/x", { priority: "interactive", perPage: 10, maxPages: 5 });
    expect(r.items).toHaveLength(25);
    expect(r.total).toBe(25);
    expect(c.calls).toBe(3);
  });
  it("refuses to walk past maxPages (and maxPages 1 is first-page-only)", async () => {
    expect((await listAll(pages(0, true), "/x", { priority: "interactive", perPage: 10, maxPages: 1 })).total).toBe(1e6);
    await expect(listAll(pages(0, true), "/x", { priority: "interactive", perPage: 10, maxPages: 3 })).rejects.toThrow(/more than 3 pages/);
  });
});
