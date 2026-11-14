/**
 * Envelope and request helpers shared by the fake Cloudflare route handlers.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/envelope.ts
 * ├── test/provisioning/fake-cloudflare/access.ts
 * ├── test/provisioning/fake-cloudflare/dns.ts
 * ├── test/provisioning/fake-cloudflare/index.ts
 * └── test/provisioning/fake-cloudflare/tunnels.ts
 * <module-headers:end>
 */

export interface FakeReq {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | null;
}

export type Handler = (req: FakeReq) => Response | null;

export function ok(result: unknown, status = 200, info?: Record<string, number>): Response {
  return Response.json({ success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) }, { status });
}

export function fail(status: number, code: number, message: string): Response {
  return Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

export const notFound = () => fail(404, 1003, "Not found");

/** Page-based slicing with `result_info`, like every list endpoint the engine uses. */
export function paged<T>(items: T[], q: URLSearchParams): Response {
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const perPage = Math.max(1, Number(q.get("per_page") ?? 20));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return ok(slice, 200, {
    page,
    per_page: perPage,
    count: slice.length,
    total_count: items.length,
    total_pages: Math.max(1, Math.ceil(items.length / perPage)),
  });
}

export function match(path: string, re: RegExp): string[] | null {
  const m = re.exec(path);
  return m ? m.slice(1) : null;
}
