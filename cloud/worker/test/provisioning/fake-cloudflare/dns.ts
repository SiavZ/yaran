/**
 * Fake DNS record endpoints, including the same-name conflict (a CNAME refused when an A,
 * AAAA or CNAME already holds the name) and the 100-character comment cap on Free.
 *
 * <module-headers:begin>
 * Uses:
 * test/provisioning/fake-cloudflare/dns.ts
 * ├── test/provisioning/fake-cloudflare/envelope.ts
 * └── test/provisioning/fake-cloudflare/state.ts
 * External: none
 *
 * Used by:
 * test/provisioning/fake-cloudflare/dns.ts
 * └── test/provisioning/fake-cloudflare/index.ts
 * <module-headers:end>
 */
import { fail, match, notFound, ok, paged, type FakeReq } from "./envelope.ts";
import type { FakeDnsRecord, FakeState } from "./state.ts";

export function dnsRoutes(st: FakeState) {
  return (req: FakeReq): Response | null => {
    const { method, path, query, body } = req;
    if (match(path, /^\/zones\/[^/]+\/dns_records$/)) {
      if (method === "GET") {
        let items = [...st.dns.values()];
        const name = query.get("name");
        if (name) items = items.filter((r) => r.name.toLowerCase() === name.toLowerCase());
        const type = query.get("type");
        if (type) items = items.filter((r) => r.type === type);
        const pre = query.get("comment.startswith");
        if (pre) items = items.filter((r) => (r.comment ?? "").startsWith(pre));
        return paged(items, query);
      }
      if (method === "POST") {
        const rec = body as unknown as FakeDnsRecord;
        if ((rec.comment ?? "").length > 100) return fail(400, 9100, "DNS record comment is too long");
        const clash = [...st.dns.values()].some((r) => r.name.toLowerCase() === rec.name.toLowerCase() && ["A", "AAAA", "CNAME"].includes(r.type));
        if (clash) return fail(400, 81053, "An A, AAAA, or CNAME record with that host already exists.");
        const r: FakeDnsRecord = { id: st.hex(32), type: rec.type, name: rec.name, content: rec.content, proxied: !!rec.proxied, ttl: rec.ttl ?? 1, comment: rec.comment ?? null };
        st.dns.set(r.id, r);
        return ok(r);
      }
      return null;
    }
    const one = match(path, /^\/zones\/[^/]+\/dns_records\/([^/]+)$/);
    if (!one) return null;
    const r = st.dns.get(one[0] ?? "");
    if (!r) return notFound();
    if (method === "GET") return ok(r);
    if (method === "PATCH") {
      Object.assign(r, body);
      return ok(r);
    }
    if (method === "DELETE") {
      st.dns.delete(r.id);
      return ok({ id: r.id });
    }
    return fail(405, 10000, "Method not allowed");
  };
}
